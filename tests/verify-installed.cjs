'use strict';

// Release-only integration check. It runs the installed backend on isolated
// loopback ports without opening an application window or fetching TV streams.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const rootArgument = process.argv.indexOf('--root');
if (rootArgument < 0 || !process.argv[rootArgument + 1]) throw new Error('Use --root with the installed application directory.');
const root = path.resolve(process.argv[rootArgument + 1]);
const node = path.join(root, 'desktop', 'runtime', 'node.exe');
const launcher = require(path.join(root, 'launch.cjs'));
const { version } = require(path.join(root, 'package.json'));
const bridges = [];
const backends = [];

async function deadline(promise, description, milliseconds = 20000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function request(origin, resource) {
  return new Promise((resolve, reject) => {
    const outgoing = http.get(new URL(resource, origin), { timeout: 5000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 2000000) response.destroy(new Error('Unexpectedly large local response.'));
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body, type: response.headers['content-type'] }));
    });
    outgoing.on('timeout', () => outgoing.destroy(new Error('Local response timed out.')));
    outgoing.on('error', reject);
  });
}

function startBridge(preferredPort, runtime) {
  assert.notEqual(preferredPort, 8767, 'The release test must not use the normal player port.');
  const child = spawn(node, [path.join(root, 'desktop', 'host.cjs')], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHANNEL_ROOM_PORT: String(preferredPort), CHANNEL_ROOM_RUNTIME_DIR: runtime },
  });
  const messages = [];
  let buffer = '', stderr = '', resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      rejectReady(new Error(`Backend exited before ready (${code}, ${signal}): ${stderr}`));
      resolve({ code, signal });
    });
  });
  child.once('error', rejectReady);
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') rejectReady(error); });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 16384) { rejectReady(new Error('Oversized backend message.')); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line); messages.push(message);
        if (message.type === 'ready') resolveReady(message);
        else if (message.type === 'error') rejectReady(new Error(message.message));
      } catch (error) { rejectReady(error); }
    }
  });
  const bridge = { child, ready, exited, messages };
  bridges.push(bridge);
  return bridge;
}

async function checkPlayer(bridge, runtime) {
  const ready = await deadline(bridge.ready, 'installed backend readiness');
  const url = new URL(ready.url);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  assert.equal(ready.ownsServer, true); assert.equal(ready.version, version);
  assert.equal(path.resolve(ready.directory), root);
  assert.equal(path.resolve(ready.runtimeDirectory), runtime);
  const healthResponse = await request(ready.url, '/api/health');
  assert.equal(healthResponse.status, 200);
  const health = JSON.parse(healthResponse.body);
  assert.equal(health.application, 'channel-room'); assert.equal(health.version, version);
  assert.equal(path.resolve(health.directory), root); assert.equal(health.port, Number(url.port));
  assert(Number.isInteger(health.pid));
  backends.push({ port: health.port, pid: health.pid, runtimeDirectory: runtime });
  for (const [resource, mime] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/styles.css', 'text/css'], ['/node_modules/hls.js/dist/hls.min.js', 'text/javascript']]) {
    const response = await request(ready.url, resource);
    assert.equal(response.status, 200, `${resource} must be present in the installed payload.`);
    assert(response.type.startsWith(mime)); assert(response.body.length > 100);
  }
  return ready;
}

async function closeBridge(bridge, origin) {
  bridge.child.stdin.end('close\n');
  const exited = await deadline(bridge.exited, 'installed backend shutdown');
  assert.equal(exited.code, 0);
  assert.deepEqual(bridge.messages.find(message => message.type === 'closed'), { type: 'closed', success: true, ownsServer: true, stopped: true });
  assert.equal(await launcher.probeHealth(Number(new URL(origin).port)), null);
}

(async () => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'charliflix-installed-startup-'));
  const fixture = http.createServer((incoming, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(incoming.url === '/api/health'
      ? { application: 'channel-room', version: '0.2.0', directory: 'another-installation', pid: process.pid, host: '127.0.0.1', port: fixture.address().port }
      : { preserved: true }));
  });
  try {
    await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
    const preferredPort = fixture.address().port;
    const first = startBridge(preferredPort, runtime);
    const ready = await checkPlayer(first, runtime);
    assert.notEqual(Number(new URL(ready.url).port), preferredPort, 'An occupied older player must get its own port.');
    await closeBridge(first, ready.url);
    assert.equal(JSON.parse((await request(`http://127.0.0.1:${preferredPort}`, '/')).body).preserved, true);
    await new Promise(resolve => fixture.close(resolve));
    const second = startBridge(preferredPort, runtime);
    const secondReady = await checkPlayer(second, runtime);
    assert.equal(secondReady.url, ready.url, 'The saved port must keep the settings origin stable after the preferred port becomes free.');
    await closeBridge(second, secondReady.url);
    console.log('Installed backend: HTTP player assets, occupied-port fallback, stable saved origin and owned shutdown passed.');
  } finally {
    for (const bridge of bridges) {
      if (bridge.child.exitCode === null && bridge.child.signalCode === null) {
        if (!bridge.child.stdin.destroyed) bridge.child.stdin.end();
        try { await deadline(bridge.exited, 'test cleanup'); } catch { bridge.child.kill(); }
      }
    }
    for (const backend of backends) {
      const health = await launcher.probeHealth(backend.port);
      if (health?.pid === backend.pid) await launcher.stop({ ...backend, expectedPid: backend.pid });
    }
    await new Promise(resolve => fixture.close(() => resolve()));
    await fs.rm(runtime, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
