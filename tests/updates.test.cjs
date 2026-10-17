'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { UpdateChecker, versionMetadata, isReleasePageUrl, compareVersions } = require('../lib/updates.cjs');
const { createServer } = require('../server.cjs');

const release = (version = '0.3.0', extra = {}) => ({ tag_name: `v${version}`, draft: false, prerelease: false, html_url: `https://github.com/charlesmbeckwith/charliflix/releases/tag/v${version}`, ...extra });
const json = value => new Response(JSON.stringify(value));

test('release checks are opt-in, fixed to the public API, anonymous, deduplicated and cached', async () => {
  let now = 0;
  const calls = [];
  const checker = new UpdateChecker({ currentVersion: '0.2.0', cacheMs: 100, now: () => now, fetchImpl: async (...args) => { calls.push(args); return json(release()); } });
  assert.equal(calls.length, 0);
  const results = await Promise.all([checker.check(), checker.check()]);
  assert.deepEqual(results[0], { currentVersion: '0.2.0', status: 'available', latestVersion: '0.3.0', releaseUrl: release().html_url });
  assert.deepEqual(results[0], results[1]);
  results[0].releaseUrl = 'https://attacker.example';
  assert.equal((await checker.check()).releaseUrl, release().html_url, 'a caller cannot mutate cached metadata');
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, 'https://api.github.com/repos/charlesmbeckwith/charliflix/releases/latest');
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'manual');
  assert.deepEqual(options.headers, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Charliflix/0.2.0' });
  now = 100;
  await checker.check();
  assert.equal(calls.length, 2);
});

test('semantic version ordering never prompts a downgrade and supports multi-digit components', async () => {
  assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
  assert.equal(compareVersions('10.0.0', '2.99.99'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.1.9', '0.2.0'), -1);
  assert.throws(() => compareVersions('01.2.0', '0.2.0'));
  for (const version of ['0.2.0', '0.1.0']) {
    const checker = new UpdateChecker({ currentVersion: '0.2.0', fetchImpl: async () => json(release(version)) });
    assert.equal((await checker.check()).status, 'current');
  }
});

test('release-page navigation accepts only this repository and stable release URLs', () => {
  assert.equal(isReleasePageUrl('https://github.com/charlesmbeckwith/charliflix/releases/latest'), true);
  assert.equal(isReleasePageUrl(release().html_url), true);
  for (const value of [null, '', 'https://github.com/charlesmbeckwith/charliflix', 'http://github.com/charlesmbeckwith/charliflix/releases/tag/v0.3.0', 'https://github.com:443/charlesmbeckwith/charliflix/releases/tag/v0.3.0', 'https://github.com/charlesmbeckwith/charliflix/releases/tag/v0.3.0?download=1', 'https://github.com/charlesmbeckwith/charliflix/releases/tag/v0.3.0#asset', 'https://user@github.com/charlesmbeckwith/charliflix/releases/tag/v0.3.0', 'https://github.com.attacker.example/charlesmbeckwith/charliflix/releases/tag/v0.3.0', 'https://github.com/other/channel-room/releases/tag/v0.3.0', 'https://github.com/charlesmbeckwith/charliflix/releases/tag/v0.3.0-beta', 'https://github.com/charlesmbeckwith/charliflix/releases/tag/v00.3.0', 'https://github.com/charlesmbeckwith/charliflix/releases/tag/v0.3.0/']) {
    assert.equal(isReleasePageUrl(value), false, String(value));
  }
});

test('drafts, prereleases, unexpected release links and malformed JSON never produce download links', async () => {
  for (const data of [release('0.3.0', { draft: true }), release('0.3.0', { prerelease: true }), release('0.3.0-beta'), release('0.3.0', { tag_name: '0.3.0' }), release('0.3.0', { html_url: 'https://attacker.example/download' }), release('0.3.0', { html_url: release('0.4.0').html_url }), release('0.3.0', { html_url: `${release().html_url}?x=1` }), null, {}, '<html>error</html>']) {
    const checker = new UpdateChecker({ currentVersion: '0.2.0', fetchImpl: async () => json(data) });
    assert.deepEqual(await checker.check(), { currentVersion: '0.2.0', status: 'unavailable', reason: 'invalid-response' });
  }
  const checker = new UpdateChecker({ currentVersion: '0.2.0', fetchImpl: async () => new Response('{broken') });
  assert.equal((await checker.check()).reason, 'invalid-response');
});

test('missing releases and rate limits have distinct recoverable results without exposing GitHub response bodies', async () => {
  for (const [status, expected] of [[404, { status: 'no-release' }], [403, { status: 'unavailable', reason: 'rate-limit' }], [429, { status: 'unavailable', reason: 'rate-limit' }], [500, { status: 'unavailable', reason: 'network' }], [302, { status: 'unavailable', reason: 'network' }]]) {
    let calls = 0;
    const checker = new UpdateChecker({ currentVersion: '0.2.0', fetchImpl: async () => { calls++; return new Response('untrusted upstream content', { status, headers: { location: 'https://attacker.example' } }); } });
    assert.deepEqual(await checker.check(), { currentVersion: '0.2.0', ...expected });
    assert.equal(calls, 1, 'redirects are never followed');
  }
});

test('release response reading is bounded for both advertised lengths and chunked responses', async () => {
  for (const headers of [{}, { 'content-length': String(256 * 1024 + 1) }]) {
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel() { cancelled = true; } });
    const checker = new UpdateChecker({ currentVersion: '0.2.0', fetchImpl: async () => new Response(body, { headers }) });
    assert.deepEqual(await checker.check(), { currentVersion: '0.2.0', status: 'unavailable', reason: 'invalid-response' });
    assert.equal(cancelled, true);
  }
});

test('slow requests time out and failed checks expire sooner so retrying can recover', async () => {
  const slow = new UpdateChecker({ currentVersion: '0.2.0', timeoutMs: 10, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })) });
  assert.deepEqual(await slow.check(), { currentVersion: '0.2.0', status: 'unavailable', reason: 'timeout' });
  let now = 0;
  let calls = 0;
  const checker = new UpdateChecker({ currentVersion: '0.2.0', now: () => now, fetchImpl: async () => { if (++calls === 1) throw new Error('private diagnostic detail'); return json(release()); } });
  assert.deepEqual(await checker.check(), { currentVersion: '0.2.0', status: 'unavailable', reason: 'network' });
  now = 29999;
  await checker.check();
  assert.equal(calls, 1);
  now = 30000;
  assert.equal((await checker.check()).status, 'available');
  assert.equal(calls, 2);
});

test('version metadata is local, source-controlled package version, and update routes keep the local request boundary', async t => {
  let calls = 0;
  let closed = false;
  const server = createServer({ provider: { listChannels: () => [] }, updates: { check: async () => { calls++; return { currentVersion: versionMetadata().version, status: 'no-release' }; }, close: () => { closed = true; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/version`);
  assert.deepEqual(await response.json(), { version: require('../package.json').version, repository: 'charlesmbeckwith/charliflix', latestReleasePage: 'https://github.com/charlesmbeckwith/charliflix/releases/latest' });
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(calls, 0, 'reading version metadata does not check GitHub');
  assert.equal((await fetch(`${base}/api/updates`, { method: 'HEAD' })).status, 405);
  assert.equal((await fetch(`${base}/api/updates?url=https://attacker.example`)).status, 400);
  assert.equal((await fetch(`${base}/api/updates`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/updates`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const hostile = await new Promise((resolve, reject) => http.get(`${base}/api/updates`, { headers: { Host: 'attacker.example' } }, result => { result.resume(); resolve(result.statusCode); }).on('error', reject));
  assert.equal(hostile, 403);
  assert.equal(calls, 0);
  assert.equal((await fetch(`${base}/api/updates`)).status, 200);
  assert.equal(calls, 1);
  await new Promise(resolve => server.close(resolve));
  assert.equal(closed, true);
});
