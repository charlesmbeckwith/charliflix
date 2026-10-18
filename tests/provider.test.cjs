'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ChannelProvider, parseSourceUrl, parseCastEmbedUrl, rewritePlaylist, assertAllowedMediaUrl, isPublicAddress, readBounded } = require('../lib/provider.cjs');
const { createServer } = require('../server.cjs');

const edge = 'https://edge.example.sbs';

test('the fixed channel catalog includes the five favorites and skips the unavailable PBS source', () => {
  const provider = new ChannelProvider();
  const catalog = provider.listChannels();
  assert.deepEqual(catalog.map(item => item.id), ['339', '310', '317', '298', '303', '51', '52', '53', '54', '210', '300']);
  assert.deepEqual(catalog.filter(item => item.pinned).map(({ id, name, category, enabled }) => ({ id, name, category, enabled })), [
    { id: '339', name: 'Cartoon Network', category: 'favorites', enabled: true },
    { id: '310', name: 'Comedy Central', category: 'favorites', enabled: true },
    { id: '317', name: 'FX', category: 'favorites', enabled: true },
    { id: '298', name: 'FXX', category: 'favorites', enabled: true },
    { id: '303', name: 'AMC', category: 'favorites', enabled: true },
  ]);
  assert.equal(catalog.filter(item => item.enabled).length, 10);
  assert.equal(new Set(catalog.map(item => item.id)).size, catalog.length);
  assert.throws(() => provider.channel('210'), /not configured/);
  assert.throws(() => provider.channel('https://attacker.example'), /not configured/);
  assert.throws(() => provider.channel('99999'), /not configured/);
});

test('literal source parsing accepts the observed provider format without evaluating scripts', () => {
  assert.equal(parseSourceUrl(`<script>const SRC = '${edge}/premium339/index.m3u8';</script>`), `${edge}/premium339/index.m3u8`);
  assert.throws(() => parseSourceUrl(`const SRC = makeUrl();`), /changed its player/);
  assert.throws(() => parseSourceUrl(`const SRC = 'http://edge.example.sbs/index.m3u8';`), /outside the permitted/);
  assert.throws(() => parseSourceUrl(`const SRC = 'https://attacker.example/index.m3u8';`), /unrecognized/);
  assert.throws(() => parseSourceUrl(`const SRC = 'https://edge.example.sbs/index.m3u8'+alert('x');`), /changed its player/);
});

test('feed metadata exposes only fixed identifiers and describes the independent alternate', async () => {
  let requests = 0;
  const provider = new ChannelProvider({ fetchImpl: async () => { requests++; throw new Error('Must not fetch'); } });
  const channel = provider.listChannels().find(channel => channel.id === '310');
  assert.equal(channel.defaultFeed, 'stream');
  assert.deepEqual(channel.feeds.map(({ id, enabled }) => ({ id, enabled })), [
    { id: 'stream', enabled: true }, { id: 'cast', enabled: true },
  ]);
  assert.match(channel.feeds[0].detail, /3 and 7/);
  assert.match(channel.feeds[1].detail, /independent alternate/);
  assert.doesNotMatch(JSON.stringify(channel), /https?:\/\//);
  assert.equal(channel.castEmbedId, undefined);
  channel.feeds[0].id = 'mutated';
  assert.equal(provider.listChannels()[0].feeds[0].id, 'stream');
  for (const feed of ['https://attacker.example', '../cast', 'cast?url=https://attacker.example', 'missing']) {
    await assert.rejects(provider.getPlaylist('310', feed), error => error.code === 'UNKNOWN_FEED' && error.status === 404);
  }
  assert.equal(requests, 0);
});

test('alternate wrapper extraction accepts exactly the observed fixed embed provider', () => {
  const embed = 'https://tossequip.net/e/d2695mac448xt';
  assert.equal(parseCastEmbedUrl(`<iframe src="${embed}" allowfullscreen></iframe>`), embed);
  assert.throws(() => parseCastEmbedUrl(`<iframe data-src="${embed}"></iframe>`), /could not be found/);
  for (const value of ['https://attacker.example/e/d2695mac448xt', 'https://tossequip.net.attacker.example/e/d2695mac448xt', 'http://tossequip.net/e/d2695mac448xt', 'https://tossequip.net/e/d2695mac448xt?url=https://attacker.example', 'https://missflight.net/e/d2695mac448xt']) {
    assert.throws(() => parseCastEmbedUrl(`<iframe src="${value}"></iframe>`), /could not be found/);
  }
  assert.throws(() => parseCastEmbedUrl(`<iframe src="${embed}"></iframe><iframe src="${embed}"></iframe>`), /could not be found/);
});

test('playlist rewriting covers variants, segments, encryption keys, maps and audio renditions', () => {
  const seen = [];
  const input = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=50000\nlow/index.m3u8\n#EXTINF:5,\nhttps://v16.example.tiktokcdn-us.com/a.image?signature=x\n';
  const output = rewritePlaylist(input, `${edge}/premium339/index.m3u8`, (url, kind) => { seen.push({ url, kind }); return `/media/token${seen.length}`; });
  assert.deepEqual(seen.map(item => item.kind), ['key', 'map', 'playlist', 'playlist', 'segment']);
  assert.equal(seen[0].url, `${edge}/premium339/keys/key.bin`);
  assert.match(output, /URI="\/media\/token1"/);
  assert.match(output, /\n\/media\/token4\n/);
  assert.doesNotMatch(output, /https:\/\//);
  assert.throws(() => rewritePlaylist('<html>bad</html>', edge, () => ''), /did not return an HLS/);
});

test('media allowlist rejects arbitrary addresses, credentials, ports and private endpoints', () => {
  assert.equal(assertAllowedMediaUrl(`${edge}/a.ts`, edge).origin, edge);
  assert.equal(assertAllowedMediaUrl('https://v16-a.tiktokcdn-us.com/a.image', edge).hostname, 'v16-a.tiktokcdn-us.com');
  for (const url of ['http://edge.example.sbs/a', 'https://127.0.0.1/a', 'https://edge.other.sbs/a', 'https://evil.tiktokcdn-us.com.attacker.example/a', 'https://user:secret@edge.example.sbs/a', 'https://edge.example.sbs:444/a']) {
    assert.throws(() => assertAllowedMediaUrl(url, edge));
  }
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.1.1', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  const castOrigin = 'https://edge.7odxv0l067ka.net:8443';
  assert.equal(assertAllowedMediaUrl(`${castOrigin}/segment.ts`, castOrigin, 'cast').origin, castOrigin);
  assert.throws(() => assertAllowedMediaUrl(`${castOrigin}/segment.ts`, castOrigin));
  for (const url of ['https://other.7odxv0l067ka.net:8443/segment.ts', 'https://v16-a.tiktokcdn-us.com/a.image', 'https://edge.7odxv0l067ka.net:8444/segment.ts', `${edge}/segment.ts`]) {
    assert.throws(() => assertAllowedMediaUrl(url, castOrigin, 'cast'));
  }
});

test('independent feeds resolve and cache separately with only adapter-fixed public embed headers', async () => {
  const castOrigin = 'https://edge.7odxv0l067ka.net:8443';
  const source = `${castOrigin}/hls/example.m3u8?s=public-stream-token&e=123`;
  const encoded = Buffer.from(JSON.stringify({ stream_url: source })).toString('base64');
  const pieces = Array.from({ length: 4 }, (_, index) => Buffer.from(encoded.slice(index * encoded.length / 4, (index + 1) * encoded.length / 4)).toString('base64'));
  const envelope = [2, 0, 3, 1].map(index => pieces[index].slice(0, 3) + 'X' + pieces[index].slice(3)).join('');
  const html = `window._econfig = '${Buffer.from(envelope).toString('base64')}';`;
  const requests = [];
  const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async (url, options) => {
    requests.push({ url, headers: options.headers });
    if (url.startsWith('https://dlive.sx/')) return new Response('<iframe src="https://tossequip.net/e/d2695mac448xt"></iframe>');
    if (url.startsWith('https://tossequip.net/')) return new Response(html);
    if (url.startsWith('https://dembed.st/')) return new Response(`const SRC = '${edge}/premium310/index.m3u8';`);
    if (url.endsWith('/key.bin')) return new Response('key');
    return new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nsegment.ts\n');
  } });
  const [primary, alternate] = await Promise.all([provider.getPlaylist('310'), provider.getPlaylist('310', 'cast')]);
  await provider.getPlaylist('310');
  await provider.getPlaylist('310', 'cast');
  assert.equal(provider.sourceCache.size, 2);
  assert.equal(requests.filter(({ url }) => url.startsWith('https://dembed.st/')).length, 1);
  assert.equal(requests.filter(({ url }) => url.startsWith('https://tossequip.net/')).length, 1);
  assert.equal(requests.filter(({ url }) => url.startsWith('https://dlive.sx/')).length, 0, 'verified alternate IDs remain usable when the main website is down');
  const primaryKey = primary.body.toString().match(/URI="\/media\/([^\"]+)"/)[1];
  const alternateKey = alternate.body.toString().match(/URI="\/media\/([^\"]+)"/)[1];
  assert.notEqual(primaryKey, alternateKey);
  await provider.getMedia(alternateKey);
  for (const { url, headers } of requests) {
    assert.deepEqual(Object.keys(headers).sort(), url.startsWith('https://dembed.st/') || url.startsWith(edge) ? ['Accept'] : ['Accept', 'Referer']);
    if (url.startsWith('https://dlive.sx/') || url.startsWith('https://tossequip.net/')) assert.equal(headers.Referer, 'https://dlive.sx/');
    if (url.startsWith(castOrigin)) assert.equal(headers.Referer, 'https://tossequip.net/');
  }
});

test('response reading enforces advertised and streamed byte bounds', async () => {
  await assert.rejects(readBounded(new Response('12345', { headers: { 'content-length': '5' } }), 4), /size limit/);
  await assert.rejects(readBounded(new Response('12345'), 4), /size limit/);
  assert.equal((await readBounded(new Response('1234'), 4)).toString(), '1234');
});

test('provider fetches anonymous HTML, rewrites only registered media, and caches source resolution', async () => {
  let now = 0;
  const requests = [];
  const provider = new ChannelProvider({ verifyDns: false, now: () => now, sourceTtlMs: 100, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.startsWith('https://dembed.st/')) return new Response(`const SRC = '${edge}/premium339/index.m3u8';`);
    return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://v16-a.tiktokcdn-us.com/signed.image\n');
  } });
  const first = await provider.getPlaylist('339');
  assert.match(first.body.toString(), /\/media\/[A-Za-z0-9_-]{32}/);
  await provider.getPlaylist('339');
  assert.equal(requests.filter(item => item.url.startsWith('https://dembed.st/')).length, 1);
  now = 101;
  await provider.getPlaylist('339');
  assert.equal(requests.filter(item => item.url.startsWith('https://dembed.st/')).length, 2);
  for (const { options } of requests) {
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(Object.keys(options.headers), ['Accept']);
  }
  await assert.rejects(provider.getMedia('unregistered'), /expired/);
  await assert.rejects(provider.getPlaylist('51?url=http://127.0.0.1'), /not configured/);
});

test('registered key and initialization map resources pass through without video unwrapping', async () => {
  const bytes = Buffer.from([0, 1, 2, 3, 4]);
  const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async () => new Response(bytes) });
  const key = provider.register(`${edge}/key.bin`, 'key', edge, '339').split('/').pop();
  const map = provider.register(`${edge}/init.mp4`, 'map', edge, '339').split('/').pop();
  assert.deepEqual((await provider.getMedia(key)).body, bytes);
  assert.deepEqual((await provider.getMedia(map)).body, bytes);
});

test('resource tokens and byte caches remain isolated across channels and feeds', async () => {
  let requests = 0;
  const origin = 'https://edge.7odxv0l067ka.net';
  const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async () => new Response(`read-${++requests}`) });
  const primary = provider.register(`${origin}/key.bin`, 'key', origin, '310', 'stream').split('/').pop();
  const alternate = provider.register(`${origin}/key.bin`, 'key', origin, '310', 'cast').split('/').pop();
  const otherChannel = provider.register(`${origin}/key.bin`, 'key', origin, '317', 'stream').split('/').pop();
  assert.equal(new Set([primary, alternate, otherChannel]).size, 3);
  assert.equal(provider.register(`${origin}/key.bin`, 'key', origin, '310', 'stream'), `/media/${primary}`);
  assert.equal((await provider.getMedia(primary)).body.toString(), 'read-1');
  assert.equal((await provider.getMedia(alternate)).body.toString(), 'read-2');
  assert.equal((await provider.getMedia(otherChannel)).body.toString(), 'read-3');
  assert.equal((await provider.getMedia(primary)).body.toString(), 'read-1');
  assert.equal(requests, 3);
});

test('provider restricts redirect destinations and rejects private DNS answers before fetch', async () => {
  let calls = 0;
  const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async () => { calls++; return new Response('', { status: 302, headers: { location: 'https://127.0.0.1/a' } }); } });
  await assert.rejects(provider.sourceFor('339'), /outside its player/);
  assert.equal(calls, 1);
  const privateDns = new ChannelProvider({ resolveHost: async () => [{ address: '127.0.0.1' }], fetchImpl: async () => { throw new Error('Must not fetch'); } });
  await assert.rejects(privateDns.sourceFor('339'), /outside the public/);
});

test('token count and byte cache stay bounded and expired tokens stop resolving', async () => {
  let now = 0;
  const provider = new ChannelProvider({ verifyDns: false, now: () => now, maxResources: 2, tokenTtlMs: 100, maxCacheBytes: 4, fetchImpl: async () => new Response('1234') });
  const first = provider.register(`${edge}/one.key`, 'key', edge, '339').split('/').pop();
  const second = provider.register(`${edge}/two.key`, 'key', edge, '339').split('/').pop();
  await provider.getMedia(first);
  await provider.getMedia(second);
  assert.equal(provider.cachedBytes, 4);
  provider.register(`${edge}/three.key`, 'key', edge, '339');
  assert.equal(provider.resources.size, 2);
  await assert.rejects(provider.getMedia(first), /expired/);
  now = 101;
  await assert.rejects(provider.getMedia(second), /expired/);
  assert.equal(provider.resources.size, 0);
});

test('HTTP routes reject cross-site use, hostile Host values, traversal, arbitrary proxies and unknown channels', async t => {
  const server = createServer({ provider: new ChannelProvider() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/channels`)).status, 200);
  assert.equal((await fetch(`${base}/api/channels`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/api/channels`, { headers: { Host: 'attacker.example' } }, result => {
      result.resume();
      resolve(result.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(`${base}/api/channels/99999/playlist.m3u8`)).status, 404);
  assert.equal((await fetch(`${base}/api/channels/310/feeds/missing/playlist.m3u8`)).status, 404);
  assert.equal((await fetch(`${base}/api/channels/310/feeds/https%3A%2F%2Fattacker.example/playlist.m3u8`)).status, 404);
  assert.equal((await fetch(`${base}/api/channels/310/feeds/stream/playlist.m3u8?url=https://attacker.example`)).status, 400);
  assert.equal((await fetch(`${base}/media/https%3A%2F%2Fattacker.example`)).status, 404);
  assert.equal((await fetch(`${base}/api/channels?url=https://attacker.example`)).status, 400);
  assert.equal((await fetch(`${base}/%2e%2e/config/channels.json`)).status, 404);
  const result = await fetch(`${base}/api/channels`);
  assert.match(result.headers.get('content-security-policy'), /frame-src 'none'/);
  assert.equal(result.headers.get('access-control-allow-origin'), null);
});

test('the original playlist route remains an alias for the fixed default feed', async t => {
  const calls = [];
  const provider = { listChannels: () => [], getPlaylist: async (...args) => {
    calls.push(args);
    return { body: Buffer.from('#EXTM3U\n'), contentType: 'application/vnd.apple.mpegurl' };
  } };
  const server = createServer({ provider });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/channels/310/playlist.m3u8`)).status, 200);
  assert.equal((await fetch(`${base}/api/channels/310/feeds/stream/playlist.m3u8`)).status, 200);
  assert.deepEqual(calls, [['310'], ['310', 'stream']]);
});
