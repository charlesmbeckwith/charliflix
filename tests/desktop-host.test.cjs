'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { start, stop, probeHealth } = require('../launch.cjs');

const ROOT = path.resolve(__dirname, '..');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const evidence = {
  timestamp: new Date().toISOString(),
  scope: 'Isolated loopback ports only; production port 8767 was not read or modified; no UI launched.',
  tests: [],
};

async function deadline(promise, description, milliseconds = 16000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  assert.notEqual(port, 8767, 'Tests must never use the normal application port.');
  return port;
}

function runHost(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'desktop', 'host.cjs')], {
    cwd: ROOT,
    env: { ...process.env, CHANNEL_ROOM_HOST: '127.0.0.1', CHANNEL_ROOM_PORT: String(port) },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  let buffer = '';
  let stderr = '';
  let protocolError;
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') protocolError = error; });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      try { messages.push(JSON.parse(line)); } catch (error) { protocolError = error; }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, messages, exited, stderr: () => stderr, protocolError: () => protocolError };
}

async function awaitReady(host) {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    if (host.protocolError()) throw host.protocolError();
    const message = host.messages.find(item => item.type === 'ready' || item.type === 'error');
    if (message) {
      assert.equal(message.type, 'ready', JSON.stringify(message));
      return message;
    }
    if (host.child.exitCode !== null) throw new Error(`Host exited before readiness: ${host.stderr()}`);
    await pause(25);
  }
  throw new Error('The desktop bridge did not become ready.');
}

async function cleanup(context) {
  if (context.host && context.host.child.exitCode === null) {
    context.host.child.stdin.end();
    try { await deadline(context.host.exited, 'bridge cleanup'); }
    catch { context.host.child.kill('SIGKILL'); }
  }
  const health = await probeHealth(context.port);
  // Only PIDs observed while starting a server in this test are eligible.
  if (health && context.ownedPids.has(health.pid)) {
    await stop({ port: context.port, expectedPid: health.pid });
  }
}

function lifecycleTest(name, body) {
  test(name, { timeout: 35000 }, async () => {
    const context = { port: await unusedPort(), ownedPids: new Set(), host: null };
    let result;
    try {
      result = await body(context);
      evidence.tests.push({ name, passed: true, port: context.port, ...result });
    } catch (error) {
      evidence.tests.push({ name, passed: false, port: context.port, error: error.message });
      throw error;
    } finally { await cleanup(context); }
  });
}

for (const mode of ['command close', 'stdin EOF', 'EOF during startup']) {
  lifecycleTest(`desktop bridge cleans up its server after ${mode}`, async context => {
    context.host = runHost(context.port);
    let serverPid = null;
    if (mode !== 'EOF during startup') {
      assert.equal((await awaitReady(context.host)).ownsServer, true);
      const health = await probeHealth(context.port);
      assert.equal(health.application, 'channel-room');
      serverPid = health.pid;
      context.ownedPids.add(serverPid);
    }
    if (mode === 'command close') context.host.child.stdin.write('close\n');
    else context.host.child.stdin.end();
    const exited = await deadline(context.host.exited, mode);
    assert.equal(exited.code, 0, context.host.stderr());
    assert.equal(await probeHealth(context.port), null);
    assert.deepEqual(context.host.messages.filter(message => message.type === 'cleanup-error'), []);
    return { ownedServerPid: serverPid, hostExitCode: exited.code, serverStopped: true };
  });
}

lifecycleTest('desktop bridge preserves a preexisting server it reused', async context => {
  const existing = await start({ open: false, port: context.port });
  assert(Number.isInteger(existing.pid), 'The fixture must start a new server.');
  context.ownedPids.add(existing.pid);
  context.host = runHost(context.port);
  assert.equal((await awaitReady(context.host)).ownsServer, false);
  context.host.child.stdin.end();
  const exited = await deadline(context.host.exited, 'reused bridge close');
  assert.equal(exited.code, 0);
  assert.equal((await probeHealth(context.port)).pid, existing.pid);
  return { preexistingServerPid: existing.pid, hostExitCode: exited.code, serverPreserved: true };
});

lifecycleTest('desktop bridge preserves a replacement for its original server', async context => {
  context.host = runHost(context.port);
  assert.equal((await awaitReady(context.host)).ownsServer, true);
  const original = await probeHealth(context.port);
  context.ownedPids.add(original.pid);
  await stop({ port: context.port, expectedPid: original.pid });
  const replacement = await start({ open: false, port: context.port });
  assert(Number.isInteger(replacement.pid), 'The fixture must start a new replacement.');
  assert.notEqual(replacement.pid, original.pid);
  context.ownedPids.add(replacement.pid);
  context.host.child.stdin.end();
  const exited = await deadline(context.host.exited, 'replaced bridge close');
  assert.equal(exited.code, 0);
  assert.equal((await probeHealth(context.port)).pid, replacement.pid);
  return { originalServerPid: original.pid, replacementServerPid: replacement.pid, serverPreserved: true };
});

test.after(async () => {
  evidence.passed = evidence.tests.length === 5 && evidence.tests.every(result => result.passed);
  const directory = path.join(ROOT, '.test-artifacts');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'desktop-host-verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
});
