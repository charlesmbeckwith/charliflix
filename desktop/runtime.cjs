'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const launcher = require('../launch.cjs');

const HOST = '127.0.0.1';
const RECORD_LIMIT = 4096;
const MAX_ATTEMPTS = 5;

async function readSavedPort(runtime) {
  const file = path.join(runtime, 'desktop-port.json');
  let handle;
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size > RECORD_LIMIT) return null;
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(RECORD_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > RECORD_LIMIT) return null;
    let record;
    try { record = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); }
    catch { return null; }
    if (record?.application !== 'channel-room' || record.schema !== 1 || record.host !== HOST ||
        !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 ||
        record.runtimeDirectory !== runtime || !path.isAbsolute(record.runtimeDirectory)) return null;
    return record.port;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}

async function rememberPort(runtime, port) {
  const file = path.join(runtime, 'desktop-port.json');
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const record = `${JSON.stringify({ application: 'channel-room', schema: 1, host: HOST, port, runtimeDirectory: runtime })}\n`;
  if (Buffer.byteLength(record) > RECORD_LIMIT) throw new Error('The desktop connection record is too large.');
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(record);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function selectFreePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen({ host: HOST, port: 0, exclusive: true }, resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  // launch.start checks and owns this port. Another process may claim it after
  // release; only that typed collision is eligible for the bounded retry below.
  return port;
}

async function startDesktop(options = {}, dependencies = {}) {
  const startPlayer = dependencies.startPlayer || launcher.start;
  const stopPlayer = dependencies.stopPlayer || launcher.stop;
  const choosePort = dependencies.selectFreePort || selectFreePort;
  const runtime = launcher.runtimeDirectory(options.runtimeDirectory);
  const preferred = launcher.validatePort(options.port ?? process.env.CHANNEL_ROOM_PORT ?? 8767);
  await fs.mkdir(runtime, { recursive: true });
  const saved = await readSavedPort(runtime);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const port = attempt === 0 ? (saved ?? preferred) : launcher.validatePort(await choosePort());
    let result;
    try { result = await startPlayer({ open: false, requireOwned: true, port, runtimeDirectory: runtime }); }
    catch (error) {
      if (error.code === 'EPLAYER_PORT_BUSY') continue;
      throw error;
    }
    if (!Number.isInteger(result?.pid) || result.pid < 1 || result.port !== port || result.url !== `http://${HOST}:${port}`) {
      throw new Error('The desktop launcher did not identify its own local player.');
    }
    try { await rememberPort(runtime, port); }
    catch (error) {
      await stopPlayer({ port, expectedPid: result.pid, runtimeDirectory: runtime });
      throw new Error(`The desktop connection could not be saved: ${error.message}`);
    }
    return { ...result, runtimeDirectory: runtime };
  }
  const error = new Error('The local player could not find an available connection. Close Charliflix and try again.');
  error.code = 'EPLAYER_PORT_BUSY';
  throw error;
}

module.exports = { startDesktop, readSavedPort, rememberPort, selectFreePort, MAX_ATTEMPTS };
