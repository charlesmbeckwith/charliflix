'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { start, stop, probeHealth, runtimeDirectory } = require('../launch.cjs');
const { version } = require('../package.json');

const ROOT = path.resolve(__dirname, '..');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const evidence = {
  timestamp: new Date().toISOString(),
  scope: 'Isolated loopback ports only; production port 8767 was not read or modified; no UI launched.',
  tests: [],
};
let lifecycleCount = 0;

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

function runHost(port, runtime) {
  const child = spawn(process.execPath, [path.join(ROOT, 'desktop', 'host.cjs')], {
    cwd: ROOT,
    env: { ...process.env, CHANNEL_ROOM_HOST: '127.0.0.1', CHANNEL_ROOM_PORT: String(port), ...(runtime ? { CHANNEL_ROOM_RUNTIME_DIR: runtime } : {}) },
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

async function readyFor(context) {
  const ready = await awaitReady(context.host);
  const selected = new URL(ready.url);
  assert.equal(selected.protocol, 'http:');
  assert.equal(selected.hostname, '127.0.0.1');
  const port = Number(selected.port);
  assert.notEqual(port, 8767, 'Tests must never use the normal application port.');
  context.activePort = port;
  context.ports.add(port);
  const health = await probeHealth(port);
  assert.equal(health?.application, 'channel-room');
  assert.equal(health.version, version);
  assert.equal(health.directory, ROOT);
  context.ownedPids.add(health.pid);
  return ready;
}

async function cleanup(context) {
  if (context.host && context.host.child.exitCode === null) {
    context.host.child.stdin.end();
    try { await deadline(context.host.exited, 'bridge cleanup'); }
    catch { context.host.child.kill('SIGKILL'); }
  }
  for (const port of context.ports) {
    const health = await probeHealth(port);
    // Only PIDs observed while starting a server in this test are eligible.
    if (health && context.ownedPids.has(health.pid)) {
      await stop({ port, expectedPid: health.pid, runtimeDirectory: context.runtimeDirectory });
    }
  }
  if (context.runtimeDirectory) await fs.rm(context.runtimeDirectory, { recursive: true, force: true });
}

function lifecycleTest(name, body) {
  lifecycleCount++;
  test(name, { timeout: 35000 }, async () => {
    const port = await unusedPort();
    const context = { port, ports: new Set([port]), ownedPids: new Set(), host: null,
      runtimeDirectory: await fs.mkdtemp(path.join(os.tmpdir(), 'charliflix-desktop-lifecycle-')) };
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
    context.host = runHost(context.port, context.runtimeDirectory);
    let serverPid = null;
    if (mode !== 'EOF during startup') {
      assert.equal((await readyFor(context)).ownsServer, true);
      const health = await probeHealth(context.port);
      assert.equal(health.application, 'channel-room');
      assert.equal(health.version, version);
      assert.equal(health.directory, ROOT);
      serverPid = health.pid;
      context.ownedPids.add(serverPid);
    }
    if (mode === 'command close') context.host.child.stdin.write('close\n');
    else context.host.child.stdin.end();
    const exited = await deadline(context.host.exited, mode);
    assert.equal(exited.code, 0, context.host.stderr());
    assert.equal(await probeHealth(context.port), null);
    assert.deepEqual(context.host.messages.filter(message => message.type === 'cleanup-error'), []);
    assert.deepEqual(context.host.messages.find(message => message.type === 'closed'), { type: 'closed', success: true, ownsServer: true, stopped: true });
    return { ownedServerPid: serverPid, hostExitCode: exited.code, serverStopped: true };
  });
}

lifecycleTest('desktop bridge owns a fallback and preserves a preexisting player', async context => {
  const existing = await start({ open: false, port: context.port, runtimeDirectory: context.runtimeDirectory });
  assert(Number.isInteger(existing.pid), 'The fixture must start a new server.');
  context.ownedPids.add(existing.pid);
  context.host = runHost(context.port, context.runtimeDirectory);
  const ready = await readyFor(context);
  assert.equal(ready.ownsServer, true);
  assert.notEqual(context.activePort, context.port);
  context.host.child.stdin.end();
  const exited = await deadline(context.host.exited, 'reused bridge close');
  assert.equal(exited.code, 0);
  assert.equal((await probeHealth(context.port)).pid, existing.pid);
  assert.equal(await probeHealth(context.activePort), null);
  assert.deepEqual(context.host.messages.find(message => message.type === 'closed'), { type: 'closed', success: true, ownsServer: true, stopped: true });
  return { preexistingServerPid: existing.pid, hostExitCode: exited.code, serverPreserved: true };
});

lifecycleTest('browser launcher still reuses its matching server by default', async context => {
  const existing = await start({ open: false, port: context.port, runtimeDirectory: context.runtimeDirectory });
  context.ownedPids.add(existing.pid);
  const reused = await start({ open: false, port: context.port, runtimeDirectory: context.runtimeDirectory });
  assert.equal(reused.pid, undefined);
  assert.equal(reused.url, existing.url);
  assert.equal((await probeHealth(context.port)).pid, existing.pid);
  return { browserReusePreserved: true, serverPid: existing.pid };
});

lifecycleTest('desktop bridge preserves an unrelated non-player listener', async context => {
  const fixture = http.createServer((_request, response) => response.end('another local application'));
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(context.port, '127.0.0.1', resolve); });
  try {
    await assert.rejects(start({ open: false, port: context.port, runtimeDirectory: context.runtimeDirectory, requireOwned: true }), { code: 'EPLAYER_PORT_BUSY' });
    context.host = runHost(context.port, context.runtimeDirectory);
    assert.equal((await readyFor(context)).ownsServer, true);
    assert.notEqual(context.activePort, context.port);
    context.host.child.stdin.end();
    assert.equal((await deadline(context.host.exited, 'unrelated-listener fallback close')).code, 0);
    assert.equal(await probeHealth(context.activePort), null);
    assert.equal(await (await fetch(`http://127.0.0.1:${context.port}/`)).text(), 'another local application');
    return { unrelatedListenerPreserved: true, ownedFallbackStopped: true };
  } finally { await new Promise(resolve => fixture.close(resolve)); }
});

lifecycleTest('desktop bridge bypasses a legacy listener and remembers its fallback origin', async context => {
  let fixtureClosed = false;
  const fixture = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    // The old development backend did not advertise installation/version identity.
    response.end(JSON.stringify({ application: 'channel-room', pid: process.pid, host: '127.0.0.1', port: context.port }));
  });
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(context.port, '127.0.0.1', resolve); });
  try {
    context.host = runHost(context.port, context.runtimeDirectory);
    const first = await readyFor(context);
    assert.equal(first.ownsServer, true);
    const savedPort = context.activePort;
    assert.notEqual(savedPort, context.port);
    assert.equal((await probeHealth(context.port)).pid, process.pid, 'The legacy listener must remain untouched.');
    const recordPath = path.join(context.runtimeDirectory, 'desktop-port.json');
    const saved = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    assert.deepEqual(saved, { application: 'channel-room', schema: 1, host: '127.0.0.1', port: savedPort, runtimeDirectory: context.runtimeDirectory });
    const response = await fetch(`${first.url}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Charliflix/);
    context.host.child.stdin.end();
    assert.equal((await deadline(context.host.exited, 'fallback bridge close')).code, 0);
    assert.equal(await probeHealth(savedPort), null);
    assert.equal((await probeHealth(context.port)).pid, process.pid);
    assert.deepEqual(context.host.messages.find(message => message.type === 'closed'), { type: 'closed', success: true, ownsServer: true, stopped: true });

    await new Promise(resolve => fixture.close(resolve));
    fixtureClosed = true;
    assert.equal(await probeHealth(context.port), null, 'The preferred test port is now free.');
    context.host = runHost(context.port, context.runtimeDirectory);
    const restarted = await readyFor(context);
    assert.equal(restarted.url, first.url, 'A now-free preferred port must not change the saved origin.');
    context.host.child.stdin.end();
    assert.equal((await deadline(context.host.exited, 'saved fallback bridge close')).code, 0);
    assert.equal(await probeHealth(savedPort), null);
    assert.deepEqual(JSON.parse(await fs.readFile(recordPath, 'utf8')), saved);
    return { legacyListenerPreserved: true, savedFallbackPort: savedPort, stableOriginAfterRestart: true };
  } finally { if (!fixtureClosed) await new Promise(resolve => fixture.close(resolve)); }
});

lifecycleTest('desktop bridge preserves a replacement for its original server', async context => {
  context.host = runHost(context.port, context.runtimeDirectory);
  assert.equal((await readyFor(context)).ownsServer, true);
  const original = await probeHealth(context.port);
  context.ownedPids.add(original.pid);
  await stop({ port: context.port, expectedPid: original.pid, runtimeDirectory: context.runtimeDirectory });
  const replacement = await start({ open: false, port: context.port, runtimeDirectory: context.runtimeDirectory });
  assert(Number.isInteger(replacement.pid), 'The fixture must start a new replacement.');
  assert.notEqual(replacement.pid, original.pid);
  context.ownedPids.add(replacement.pid);
  context.host.child.stdin.end();
  const exited = await deadline(context.host.exited, 'replaced bridge close');
  assert.equal(exited.code, 0);
  assert.equal((await probeHealth(context.port)).pid, replacement.pid);
  assert.deepEqual(context.host.messages.find(message => message.type === 'closed'), { type: 'closed', success: true, ownsServer: true, stopped: false });
  return { originalServerPid: original.pid, replacementServerPid: replacement.pid, serverPreserved: true };
});

lifecycleTest('desktop bridge reports cleanup failure without approving an update', async context => {
  context.host = runHost(context.port, context.runtimeDirectory);
  assert.equal((await readyFor(context)).ownsServer, true);
  const original = await probeHealth(context.port);
  context.ownedPids.add(original.pid);
  const recordFile = path.join(context.runtimeDirectory, `server-${context.port}.json`);
  const recordText = await fs.readFile(recordFile, 'utf8');
  const mismatched = JSON.parse(recordText);
  mismatched.directory = path.join(ROOT, 'another-installation');
  await fs.writeFile(recordFile, JSON.stringify(mismatched));
  try {
    context.host.child.stdin.end();
    const exited = await deadline(context.host.exited, 'cleanup rejection');
    assert.equal(exited.code, 1, 'A failed cleanup must not report a successful bridge exit.');
    assert.equal(context.host.messages.filter(message => message.type === 'cleanup-error').length, 1);
    assert.deepEqual(context.host.messages.find(message => message.type === 'closed'), { type: 'closed', success: false, ownsServer: true, stopped: false });
    assert.equal((await probeHealth(context.port)).pid, original.pid, 'An identity mismatch must leave the server running.');
    return { cleanupFailureAcknowledged: true, serverPreserved: true };
  } finally { await fs.writeFile(recordFile, recordText); }
});

for (const mismatch of ['version', 'directory']) {
  lifecycleTest(`launcher rejects a server from another ${mismatch} without stopping it`, async context => {
    const fixture = http.createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        application: 'channel-room', pid: process.pid, host: '127.0.0.1', port: context.port,
        version: mismatch === 'version' ? `${version}.legacy` : version,
        directory: mismatch === 'directory' ? path.join(ROOT, 'another-installation') : ROOT,
      }));
    });
    await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(context.port, '127.0.0.1', resolve); });
    try {
      await assert.rejects(start({ open: false, port: context.port, runtimeDirectory: context.runtimeDirectory }), /Another version or installation/);
      await assert.rejects(start({ open: false, port: context.port, runtimeDirectory: context.runtimeDirectory, requireOwned: true }), { code: 'EPLAYER_PORT_BUSY' });
      assert.equal((await probeHealth(context.port)).pid, process.pid, 'The unrelated listener must remain available.');
      await assert.rejects(fs.stat(path.join(context.runtimeDirectory, `server-${context.port}.json`)), { code: 'ENOENT' });
      return { mismatch, listenerPreserved: true };
    } finally { await new Promise(resolve => fixture.close(resolve)); }
  });
}

lifecycleTest('desktop runtime and saved profile remain outside versioned application files', async context => {
  const relative = path.relative(ROOT, context.runtimeDirectory);
  assert(path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`), 'The profile fixture must be outside the application directory.');
  const profile = path.join(context.runtimeDirectory, 'desktop-profile');
  const marker = path.join(profile, 'saved-settings.txt');
  await fs.mkdir(profile);
  await fs.writeFile(marker, 'existing channel and volume settings');
  context.host = runHost(context.port, context.runtimeDirectory);
  const ready = await readyFor(context);
  assert.equal(ready.version, version);
  assert.equal(ready.directory, ROOT);
  assert.equal(ready.runtimeDirectory, context.runtimeDirectory);
  const health = await probeHealth(context.port);
  context.ownedPids.add(health.pid);
  const record = JSON.parse(await fs.readFile(path.join(context.runtimeDirectory, `server-${context.port}.json`), 'utf8'));
  assert.equal(record.directory, ROOT);
  assert.equal(record.version, version);
  await fs.stat(path.join(context.runtimeDirectory, `server-${context.port}.log`));
  await assert.rejects(fs.stat(path.join(ROOT, '.runtime', `server-${context.port}.json`)), { code: 'ENOENT' });
  context.host.child.stdin.end();
  assert.equal((await deadline(context.host.exited, 'stable user-data bridge close')).code, 0);
  assert.equal(await probeHealth(context.port), null);
  await assert.rejects(fs.stat(path.join(context.runtimeDirectory, `server-${context.port}.json`)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(marker, 'utf8'), 'existing channel and volume settings');
  return { profilePreserved: true, serverStopped: true, externalRuntimeDirectory: context.runtimeDirectory };
});

test('runtime directory override rejects relative paths', () => {
  assert.throws(() => runtimeDirectory('relative-user-data'), /absolute directory/);
  assert.throws(() => runtimeDirectory(''), /absolute directory/);
});

lifecycleTest('desktop bridge flushes its specific fatal startup error before exit', async context => {
  context.host = runHost(0, context.runtimeDirectory);
  const exited = await deadline(context.host.exited, 'fatal startup error');
  assert.equal(exited.code, 1);
  const errors = context.host.messages.filter(message => message.type === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /port between 1 and 65535/);
  assert.equal(context.host.messages.some(message => message.type === 'ready'), false);
  assert.equal(context.host.protocolError(), undefined);
  return { specificFatalErrorFlushed: true, hostExitCode: exited.code };
});

test.after(async () => {
  evidence.passed = evidence.tests.length === lifecycleCount && evidence.tests.every(result => result.passed);
  const directory = path.join(ROOT, '.test-artifacts');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'desktop-host-verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
});
