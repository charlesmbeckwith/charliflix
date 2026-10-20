'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { startOwnedServer, isAppDocumentUrl, isAppResourceUrl, isExternalPageUrl, allowsPermission } = require('../mac/runtime.cjs');
const { isReleasePageUrl } = require('../lib/updates.cjs');

function makeServer() {
  return http.createServer((_request, response) => response.end('owned player'));
}

test('Mac external links allow only fixed attribution or existing strict release pages', () => {
  const attribution = 'https://epgtalk.com/api.html';
  assert.equal(isExternalPageUrl(attribution), true);
  assert.equal(isReleasePageUrl(attribution), false, 'guide attribution does not authorize an update source');
  for (const value of [
    'https://github.com/charlesmbeckwith/charliflix/releases/latest',
    'https://github.com/charlesmbeckwith/charliflix/releases/tag/v0.4.0',
  ]) assert.equal(isExternalPageUrl(value), true, value);
  for (const value of [
    'http://epgtalk.com/api.html', 'https://epgtalk.com/', 'https://epgtalk.com/api/now/us.json',
    'https://epgtalk.com/api.html?redirect=elsewhere', 'https://epgtalk.com/api.html#section', 'https://epgtalk.com/api.html/',
    'https://epgtalk.com:443/api.html', 'https://user@epgtalk.com/api.html', 'https://epgtalk.com.attacker.example/api.html',
    'https://attacker.example/https://epgtalk.com/api.html', 'https://github.com/charlesmbeckwith/charliflix/releases/tag/v0.4.0?redirect=elsewhere',
    'https://github.com/charlesmbeckwith/charliflix/releases/tag/v0.4.0-beta', 'javascript:alert(1)', 'file:///api.html', null,
  ]) assert.equal(isExternalPageUrl(value), false, value);
});

test('Mac runtime owns a loopback listener and closes it idempotently', async t => {
  const runtime = await startOwnedServer({ createServer: makeServer, root: __dirname, preferredPort: 0 });
  t.after(() => runtime.close());
  assert.equal(runtime.server.address().address, '127.0.0.1');
  assert.equal(await (await fetch(runtime.origin)).text(), 'owned player');
  assert.equal(runtime.usedFallbackPort, false);
  assert.equal(runtime.close(), runtime.close());
  await runtime.close();
  assert.equal(runtime.server.listening, false);
  await assert.rejects(fetch(runtime.origin));
});

test('Mac runtime leaves an occupied player untouched and serves its own fallback', async t => {
  const existing = http.createServer((_request, response) => response.end('other application'));
  existing.listen(0, '127.0.0.1');
  await once(existing, 'listening');
  t.after(() => new Promise(resolve => existing.close(resolve)));
  const port = existing.address().port;
  const runtime = await startOwnedServer({ createServer: makeServer, preferredPort: port });
  t.after(() => runtime.close());
  assert.equal(runtime.usedFallbackPort, true);
  assert.notEqual(runtime.server.address().port, port);
  assert.equal(await (await fetch(runtime.origin)).text(), 'owned player');
  await runtime.close();
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'other application');
});

test('Mac runtime closes in-flight local responses instead of keeping the app alive', async t => {
  const runtime = await startOwnedServer({
    preferredPort: 0,
    createServer: () => http.createServer((_request, response) => { response.writeHead(200); response.write('stream in progress'); }),
  });
  t.after(() => runtime.close());
  const response = await fetch(runtime.origin);
  const reader = response.body.getReader();
  assert.match(Buffer.from((await reader.read()).value).toString(), /stream in progress/);
  await runtime.close();
  await assert.rejects(reader.read());
  assert.equal(runtime.server.listening, false);
});

test('Mac app documents and resources stay within the exact owned origin', () => {
  const origin = 'http://127.0.0.1:8767';
  assert.equal(isAppDocumentUrl(`${origin}/`, origin), true);
  assert.equal(isAppDocumentUrl(`${origin}/index.html`, origin), true);
  for (const url of [
    `${origin}/api/health`, `${origin}/?redirect=elsewhere`, `${origin}/#elsewhere`,
    'http://localhost:8767/', 'http://127.0.0.1:8768/', 'http://127.0.0.1:8767.example.com/',
    'https://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url',
    'http://user:password@127.0.0.1:8767/',
  ]) assert.equal(isAppDocumentUrl(url, origin), false, url);
  assert.equal(isAppResourceUrl(`${origin}/app.js`, origin), true);
  assert.equal(isAppResourceUrl(`${origin}/media/opaque-token`, origin), true);
  assert.equal(isAppResourceUrl(`blob:${origin}/worker-id`, origin), true);
  assert.equal(isAppResourceUrl('blob:https://example.com/worker-id', origin), false);
  assert.equal(isAppResourceUrl('https://example.com/script.js', origin), false);
});

test('Mac app allows ordinary fullscreen only for its own main document', () => {
  const origin = 'http://127.0.0.1:8767';
  assert.equal(allowsPermission('fullscreen', `${origin}/`, origin, true), true);
  assert.equal(allowsPermission('fullscreen', `${origin}/`, origin, false), false);
  assert.equal(allowsPermission('fullscreen', 'https://example.com/', origin, true), false);
  for (const permission of ['automatic-fullscreen', 'media', 'display-capture', 'notifications', 'clipboard-read', 'geolocation', 'midi', 'usb', 'serial', 'fileSystem']) {
    assert.equal(allowsPermission(permission, `${origin}/`, origin, true), false, permission);
  }
});
