'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createServer } = require('../server.cjs');

const root = path.resolve(__dirname, '..');
async function localServer(t, guide) {
  const server = createServer({ root, guide, provider: { listChannels: () => [] }, updates: { check: async () => ({ status: 'no-release' }) } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  t.after(close);
  return { base: `http://127.0.0.1:${server.address().port}`, close };
}

function fixture(status = 'ready') {
  return { status, fetchedAt: 1792475482473, updatedAt: 1792474729000, from: 1792471115000, until: 1792510715000,
    source: { name: 'EPGTalk', url: 'https://epgtalk.com/api.html' }, channels: [
      { id: '339', name: 'Cartoon Network', status: 'ready', listingName: 'Cartoon Network HD', scheduleNote: 'U.S. Eastern reference schedule',
        programmes: [{ id: 'fixture-event', channelId: '339', start: 1792474800000, end: 1792476600000, title: 'Example programme' }] },
      { id: '53', name: 'NBC USA', status: 'unmapped', scheduleNote: 'No verified affiliate schedule', programmes: [] },
    ] };
}

test('the local guide route preserves ready, stale and unavailable states without changing programme UTC times', async t => {
  let calls = 0;
  const guide = { check: async (...args) => {
    assert.deepEqual(args, [], 'HTTP clients cannot supply a source URL or channel mapping');
    return fixture(['ready', 'stale', 'unavailable'][calls++]);
  } };
  const { base } = await localServer(t, guide);
  for (const status of ['ready', 'stale', 'unavailable']) {
    const response = await fetch(`${base}/api/guide`);
    assert.equal(response.status, 200, 'source availability is represented in the guide payload');
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.deepEqual(await response.json(), fixture(status));
  }
  assert.equal(calls, 3);
});

test('guide requests enforce GET and the existing local origin boundary before invoking the service', async t => {
  let calls = 0;
  const { base } = await localServer(t, { check: async () => { calls++; return fixture(); } });
  const head = await fetch(`${base}/api/guide`, { method: 'HEAD' });
  assert.equal(head.status, 405);
  assert.equal(head.headers.get('allow'), 'GET');
  assert.equal((await fetch(`${base}/api/guide`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/guide?url=https://attacker.example/guide.json`)).status, 400);
  assert.equal((await fetch(`${base}/api/guide?date=2026-10-19`)).status, 400);
  assert.equal((await fetch(`${base}/api/guide`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/guide`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const hostileHost = await new Promise((resolve, reject) => http.get(`${base}/api/guide`, { headers: { Host: 'attacker.example' } }, response => {
    response.resume(); resolve(response.statusCode);
  }).on('error', reject));
  assert.equal(hostileHost, 403);
  assert.equal((await fetch(`${base}/api/guide/https%3A%2F%2Fattacker.example`)).status, 404);
  assert.equal(calls, 0);
  assert.equal((await fetch(`${base}/api/guide`, { headers: { Origin: base } })).status, 200);
  assert.equal(calls, 1);
});

test('the guide model and UI are real same-origin assets and reading player assets does not load schedules', async t => {
  let calls = 0;
  const { base } = await localServer(t, { check: async () => { calls++; return fixture(); } });
  const page = await (await fetch(`${base}/`)).text();
  const scripts = [...page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  assert(scripts.includes('/guide-model.js'));
  assert(scripts.includes('/guide-ui.js'));
  assert(scripts.indexOf('/guide-model.js') < scripts.indexOf('/guide-ui.js'), 'the scheduler model loads before its UI');
  for (const name of ['guide-model.js', 'guide-ui.js']) {
    const response = await fetch(`${base}/${name}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/javascript/);
    assert.equal(await response.text(), await fs.readFile(path.join(root, 'public', name), 'utf8'));
    assert.equal((await fetch(`${base}/${name}`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  }
  assert.equal((await fetch(`${base}/lib/guide.cjs`)).status, 404, 'the backend resolver is not a public static file');
  await fetch(`${base}/api/channels`);
  await fetch(`${base}/api/version`);
  assert.equal(calls, 0);
});

test('closing the local server closes its owned guide service exactly once', async t => {
  let closes = 0;
  const { base, close } = await localServer(t, { check: async () => fixture(), close: () => { closes++; } });
  await fetch(`${base}/api/guide`);
  await close();
  await close();
  assert.equal(closes, 1);
});
