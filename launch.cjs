'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const RUNTIME = path.join(ROOT, '.runtime');
const HOST = '127.0.0.1';
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CHANNEL_ROOM_PORT must be a port between 1 and 65535.');
  return port;
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function pathsFor(port) {
  return {
    state: path.join(RUNTIME, `server-${port}.json`),
    lock: path.join(RUNTIME, `launch-${port}.lock`),
    log: path.join(RUNTIME, `server-${port}.log`),
  };
}

function probeHealth(port) {
  return new Promise(resolve => {
    const request = http.get({ hostname: HOST, port, path: '/api/health', timeout: 1200 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 8192) request.destroy();
      });
      response.on('error', () => resolve(null));
      response.on('end', () => {
        try { resolve(response.statusCode === 200 ? JSON.parse(body) : null); }
        catch { resolve(null); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

function validIdentity(health, port, pid) {
  return health?.application === 'channel-room' && health.host === HOST && health.port === port &&
    Number.isInteger(health.pid) && health.pid > 0 && (pid === undefined || health.pid === pid);
}

function portOccupied(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: HOST, port });
    socket.setTimeout(1000);
    const finish = occupied => { socket.destroy(); resolve(occupied); };
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
    socket.once('timeout', () => finish(true));
  });
}

async function readRecord(file) {
  try {
    const info = await fs.stat(file);
    if (info.size > 8192) throw new Error('The launcher record is invalid.');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.close();
      return async () => fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readRecord(file);
      if (!existing || !Number.isInteger(existing.pid) || existing.pid < 1 || processExists(existing.pid)) {
        throw new Error('Another Channel Room launch is in progress. Try again in a moment.');
      }
      await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  throw new Error('Could not acquire the Channel Room launcher lock.');
}

async function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}

async function start(options = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Channel Room requires Node.js 22 or newer.');
  const port = validatePort(options.port ?? process.env.CHANNEL_ROOM_PORT ?? 8767);
  const files = pathsFor(port);
  const url = `http://${HOST}:${port}`;
  await fs.mkdir(RUNTIME, { recursive: true });
  const unlock = await acquireLock(files.lock);
  let spawnedPid;
  let spawnedChild;
  try {
    const existing = await probeHealth(port);
    if (existing) {
      if (!validIdentity(existing, port)) throw new Error(`Port ${port} belongs to another application. Choose another CHANNEL_ROOM_PORT.`);
      console.log(`Channel Room is already running at ${url}`);
    } else {
      if (await portOccupied(port)) throw new Error(`Port ${port} is already in use. Choose another CHANNEL_ROOM_PORT.`);
      try {
        require.resolve('hls.js/dist/hls.min.js');
        require.resolve('pngjs');
      } catch { throw new Error('Player dependencies are missing. Open a terminal in this folder and run npm ci, then start again.'); }
      const log = await fs.open(files.log, 'a');
      let child;
      try {
        child = spawn(process.execPath, [path.join(ROOT, 'server.cjs')], {
          cwd: ROOT,
          env: { ...process.env, CHANNEL_ROOM_HOST: HOST, CHANNEL_ROOM_PORT: String(port) },
          detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
        });
        spawnedChild = child;
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        spawnedPid = child.pid;
        child.unref();
      } finally { await log.close(); }
      const deadline = Date.now() + 8000;
      let ready = false;
      while (Date.now() < deadline) {
        const health = await probeHealth(port);
        if (validIdentity(health, port, spawnedPid)) { ready = true; break; }
        if (!processExists(spawnedPid)) break;
        await wait(200);
      }
      if (!ready) throw new Error(`The player did not start. Details are in ${files.log}`);
      const temporary = `${files.state}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify({ application: 'channel-room', pid: spawnedPid, host: HOST, port, directory: ROOT, started: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' });
      await fs.rename(temporary, files.state);
      console.log(`Channel Room is ready at ${url}`);
    }
  } catch (error) {
    // Use our child-process handle for failed-start cleanup, rather than a possibly reused PID.
    if (spawnedChild && spawnedChild.exitCode === null && spawnedChild.signalCode === null) {
      try { spawnedChild.kill('SIGTERM'); } catch {}
    }
    throw error;
  } finally { await unlock(); }
  if (options.open !== false) {
    try { await openBrowser(url); }
    catch { console.log(`Open ${url} in your browser.`); }
  }
  return { url, port, pid: spawnedPid };
}

async function stop(options = {}) {
  const port = validatePort(options.port ?? process.env.CHANNEL_ROOM_PORT ?? 8767);
  const files = pathsFor(port);
  const record = await readRecord(files.state);
  if (!record) { console.log('No player started by this launcher is recorded.'); return { stopped: false }; }
  if (record.application !== 'channel-room' || record.host !== HOST || record.port !== port ||
      record.directory !== ROOT || !Number.isInteger(record.pid) || record.pid < 1 || record.pid === process.pid) {
    throw new Error('The launcher record does not identify this player. No process was stopped.');
  }
  if (options.expectedPid !== undefined) {
    if (!Number.isInteger(options.expectedPid) || options.expectedPid < 1) throw new Error('The expected player PID is invalid. No process was stopped.');
    if (record.pid !== options.expectedPid) {
      console.log('The original player has been replaced. The newer player was left running.');
      return { stopped: false };
    }
  }
  const health = await probeHealth(port);
  if (!validIdentity(health, port, record.pid)) {
    if (!processExists(record.pid)) {
      await fs.unlink(files.state);
      console.log('Channel Room is already stopped.');
      return { stopped: false };
    }
    throw new Error('The running process could not be verified as this player. No process was stopped.');
  }
  process.kill(record.pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (processExists(record.pid) && Date.now() < deadline) await wait(100);
  if (processExists(record.pid)) throw new Error('The verified player did not finish stopping. Try Stop again in a moment.');
  await fs.unlink(files.state).catch(error => { if (error.code !== 'ENOENT') throw error; });
  console.log('Channel Room stopped.');
  return { stopped: true, pid: record.pid };
}

if (require.main === module) {
  const command = process.argv[2] || 'start';
  const run = command === 'start' ? () => start({ open: !process.argv.includes('--no-open') }) : command === 'stop' ? () => stop() :
    () => { throw new Error('Usage: node launch.cjs start [--no-open] | stop'); };
  Promise.resolve().then(run).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { start, stop, probeHealth, validIdentity, validatePort };
