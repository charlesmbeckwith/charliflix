'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelProvider } = require('../lib/provider.cjs');
const { cdnLivePlayerUrl } = require('../lib/cdnlive-source.cjs');

const origin = 'https://cdnlivetv.tv';
const ids = { '51': '6add40af2d4a99e07363cf6a', '52': '6add40af2d4a99e07363cf91', '53': '6add40af2d4a99e07363cff6', '54': '6add40af2d4a99e07363cfae' };
const source = (id = '51', token = 'fixture-root') => `${origin}/secure/api/v1/${ids[id]}/playlist.m3u8?token=${token}`;
const media = (id, kind) => `${origin}/stream-segment/${ids[id]}?d=fixture-${kind}&token=fixture-media`;
const resources = result => [...result.body.toString().matchAll(/\/media\/([A-Za-z0-9_-]{32})/g)].map(match => match[1]);
function fixture(url) {
  const middle = Math.floor(url.length / 2);
  const parts = [url.slice(0, middle), url.slice(middle)].map(part => Buffer.from(part).toString('base64url'));
  return `<script>function decode(s){s=s.replace(/-/g,'+').replace(/_/g,'/');return atob(s)}const partA='${parts[0]}';const partB='${parts[1]}';const url=decode(partA)+decode(partB);</script>`;
}
function packets() {
  const bytes = Buffer.alloc(3 * 188, 0xff);
  for (let i = 0; i < 3; i++) { const offset = i * 188; bytes[offset] = 0x47; bytes[offset + 1] = 0x01; bytes[offset + 2] = 0; bytes[offset + 3] = 0x10 | i; }
  return bytes;
}

test('the public CDNLiveTV choice is offered only for its four verified network entries', async t => {
  let requests = 0;
  const p = new ChannelProvider({ fetchImpl: async () => { requests++; throw Error('No request expected'); } });
  t.after(() => p.close());
  const catalog = p.listChannels();
  assert.deepEqual(catalog.filter(channel => channel.feeds.some(feed => feed.id === 'cdnlive')).map(channel => channel.id), Object.keys(ids));
  for (const channel of catalog) {
    assert.equal(channel.defaultFeed, 'stream');
    assert.deepEqual(channel.feeds.slice(0, 2).map(feed => feed.id), ['stream', 'cast']);
    if (Object.hasOwn(ids, channel.id)) {
      const extra = channel.feeds.find(feed => feed.id === 'cdnlive');
      assert.equal(extra.label, 'CDNLiveTV'); assert.equal(extra.enabled, true);
    } else if (channel.enabled) await assert.rejects(p.getPlaylist(channel.id, 'cdnlive'), error => error.code === 'UNKNOWN_FEED');
  }
  assert.doesNotMatch(JSON.stringify(catalog), /https?:|token=/);
  catalog.find(channel => channel.id === '51').feeds[2].enabled = false;
  assert.equal(p.listChannels().find(channel => channel.id === '51').feeds[2].enabled, true);
  assert.equal(requests, 0);
});

test('a CDNLiveTV tune uses its fixed public player and rewrites nested media with only adapter-fixed headers', async t => {
  const page = cdnLivePlayerUrl('51'), root = source(), audio = source('51', 'fixture-audio'), video = source('51', 'fixture-video');
  const requests = [], ts = packets();
  const p = new ChannelProvider({ verifyDns: false, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url === page) return new Response(fixture(root));
    if (url === root) return new Response(`#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="${audio}"\n#EXT-X-STREAM-INF:BANDWIDTH=500000\n${video}\n`);
    if (url === audio) return new Response(`#EXTM3U\n#EXTINF:6,\n${media('51', 'audio')}\n`);
    if (url === video) return new Response(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="${media('51', 'key')}"\n#EXT-X-MAP:URI="${media('51', 'map')}"\n#EXTINF:6,\n${media('51', 'video')}\n`);
    if (url === media('51', 'key')) return new Response('fixture-key');
    if (url === media('51', 'map')) return new Response('fixture-map');
    if ([media('51', 'audio'), media('51', 'video')].includes(url)) return new Response(ts);
    throw Error('Unexpected CDNLiveTV request');
  } });
  t.after(() => p.close());
  const master = await p.getPlaylist('51', 'cdnlive');
  const [audioToken, videoToken] = resources(master);
  assert.ok(audioToken && videoToken);
  const audioList = await p.getMedia(audioToken), videoList = await p.getMedia(videoToken);
  for (const playlist of [master, audioList, videoList]) assert.doesNotMatch(playlist.body.toString(), /https?:|fixture-(?:root|audio|video|media)/);
  const [keyToken, mapToken, segmentToken] = resources(videoList);
  assert.equal((await p.getMedia(keyToken)).body.toString(), 'fixture-key');
  assert.equal((await p.getMedia(mapToken)).body.toString(), 'fixture-map');
  const segment = await p.getMedia(segmentToken);
  assert.deepEqual(segment.body, ts); assert.equal(segment.contentType, 'video/mp2t');
  assert.deepEqual((await p.getMedia(resources(audioList)[0])).body, ts);
  assert.equal(requests.filter(request => request.url === page).length, 1);
  for (const { url, options } of requests) {
    assert.equal(options.redirect, 'manual'); assert.notEqual(options.credentials, 'include');
    if (url === page) assert.deepEqual(options.headers, { Accept: '*/*', Referer: 'https://cdnlivetv.tv/' });
    else assert.deepEqual(options.headers, { Accept: '*/*', Referer: 'https://cdnlivetv.tv/', Origin: 'https://cdnlivetv.tv' });
  }
});

test('CDNLiveTV resource and byte-cache entries remain isolated across feeds and channels', async t => {
  const requests = [], ts = packets(), remote = media('51', 'video');
  const p = new ChannelProvider({ verifyDns: false, fetchImpl: async (url, options) => { requests.push({ url, headers: options.headers }); return new Response(ts); } });
  t.after(() => p.close());
  const first = p.register(remote, 'segment', origin, '51', 'cdnlive').split('/').pop();
  const secondChannel = p.register(remote, 'segment', origin, '52', 'cdnlive').split('/').pop();
  const otherFeed = p.register(remote, 'segment', origin, '51', 'stream').split('/').pop();
  assert.equal(new Set([first, secondChannel, otherFeed]).size, 3);
  await p.getMedia(first); await p.getMedia(first);
  assert.equal(requests.length, 1, 'only the same channel and feed share cached bytes');
  await p.getMedia(secondChannel); await p.getMedia(otherFeed);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].headers.Origin, 'https://cdnlivetv.tv');
  assert.equal(requests[1].headers.Origin, 'https://cdnlivetv.tv');
  assert.deepEqual(requests[2].headers, { Accept: '*/*' });
});

test('invalid CDNLiveTV envelopes fail as SOURCE_CHANGED without leaking page content or requesting media', async t => {
  for (const body of ['<script>throw new Error("private-fixture-content")</script>', fixture('https://attacker.example/live.m3u8')]) {
    let requests = 0;
    const p = new ChannelProvider({ verifyDns: false, fetchImpl: async () => { requests++; return new Response(body); } });
    t.after(() => p.close());
    await assert.rejects(p.getPlaylist('51', 'cdnlive'), error => error.code === 'SOURCE_CHANGED' && !/private-fixture|attacker/.test(error.message));
    assert.equal(requests, 1);
  }
});

test('CDNLiveTV page and playlist redirects are rejected before another request leaves the fixed endpoint', async t => {
  const page = cdnLivePlayerUrl('51'), root = source();
  const destinations = ['https://attacker.example/player', cdnLivePlayerUrl('52'), page + '&extra=1'];
  for (const destination of destinations) {
    let requests = 0;
    const p = new ChannelProvider({ verifyDns: false, fetchImpl: async () => { requests++; return new Response('', { status: 302, headers: { location: destination } }); } });
    t.after(() => p.close());
    await assert.rejects(p.getPlaylist('51', 'cdnlive'), error => error.code === 'BLOCKED_SOURCE');
    assert.equal(requests, 1);
  }
  for (const destination of ['https://attacker.example/live.m3u8', 'https://api.cdnlivetv.tv/api/v1/channels/player/', `${origin}/api/v1/channels/player/?name=ABC+US`]) {
    const requests = [];
    const p = new ChannelProvider({ verifyDns: false, fetchImpl: async url => {
      requests.push(url); return url === page ? new Response(fixture(root)) : new Response('', { status: 302, headers: { location: destination } });
    } });
    t.after(() => p.close());
    await assert.rejects(p.getPlaylist('51', 'cdnlive'), error => error.code === 'BLOCKED_SOURCE');
    assert.deepEqual(requests, [page, root]);
  }
});

test('CDNLiveTV rejects private or mixed DNS for both its public player and registered media before fetching', async t => {
  for (const addresses of [[{ address: '127.0.0.1' }], [{ address: '8.8.8.8' }, { address: '10.0.0.1' }]]) {
    for (const target of ['page', 'media']) {
      let requests = 0;
      const p = new ChannelProvider({ resolveHost: async () => addresses, fetchImpl: async () => { requests++; throw Error('Private destination must never be fetched'); } });
      t.after(() => p.close());
      if (target === 'page') await assert.rejects(p.getPlaylist('51', 'cdnlive'), error => error.code === 'BLOCKED_SOURCE');
      else {
        const token = p.register(media('51', 'video'), 'segment', origin, '51', 'cdnlive').split('/').pop();
        await assert.rejects(p.getMedia(token), error => error.code === 'BLOCKED_SOURCE');
      }
      assert.equal(requests, 0);
    }
  }
});

test('concurrent CDNLiveTV tunes coalesce the source lookup and refresh it only when its cache expires', async t => {
  let now = 100000, pageRequests = 0, playlists = 0;
  const page = cdnLivePlayerUrl('51');
  const p = new ChannelProvider({ verifyDns: false, now: () => now, sourceTtlMs: 60000, fetchImpl: async url => {
    if (url === page) { pageRequests++; await new Promise(setImmediate); return new Response(fixture(source())); }
    playlists++; return new Response('#EXTM3U\n');
  } });
  t.after(() => p.close());
  await Promise.all([p.getPlaylist('51', 'cdnlive'), p.getPlaylist('51', 'cdnlive')]);
  assert.equal(pageRequests, 1); assert.equal(playlists, 2);
  await p.getPlaylist('51', 'cdnlive'); assert.equal(pageRequests, 1);
  now += 60001;
  await p.getPlaylist('51', 'cdnlive'); assert.equal(pageRequests, 2);
});

test('an expired CDNLiveTV URL is resolved once more for 401, 403, 404 or 410 and repeated failures remain bounded', async t => {
  for (const status of [401, 403, 404, 410]) {
    await t.test(String(status), async t => {
      for (const recover of [true, false]) {
        let pageRequests = 0, playlistRequests = 0;
        const page = cdnLivePlayerUrl('51');
        const p = new ChannelProvider({ verifyDns: false, fetchImpl: async url => {
          if (url === page) return new Response(fixture(source('51', `fixture-${++pageRequests}`)));
          playlistRequests++;
          return recover && playlistRequests === 2 ? new Response('#EXTM3U\n') : new Response('', { status });
        } });
        t.after(() => p.close());
        if (recover) assert.match((await p.getPlaylist('51', 'cdnlive')).body.toString(), /^#EXTM3U/);
        else await assert.rejects(p.getPlaylist('51', 'cdnlive'), error => error.upstreamStatus === status);
        assert.equal(pageRequests, 2); assert.equal(playlistRequests, 2);
      }
    });
  }
});
