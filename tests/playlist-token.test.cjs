'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelProvider } = require('../lib/provider.cjs');

const edge = 'https://edge.example.sbs';
const player = (id = '339', origin = edge) => `
  const SRC = '${origin}/premium${id}/index.m3u8';
  const CHANNEL = 'premium${id}'; const EDGE = '${origin}';
  // Observed public player protocol, parsed as literals only.
  fetch(EDGE + '/api/playlist-token?slug=' + encodeURIComponent(CHANNEL));`;
const tokenReply = (token = 'fixture-token', ttl = 120) => Response.json({ token, ttl });
const manifest = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nvariant.m3u8\n';
const mediaList = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nsegment.ts\n';
const resource = output => output.body.toString().match(/\/media\/([\w-]+)/)[1];

test('main playback obtains an anonymous token and renews it for nested playlists without leaking it to media', async t => {
  let now = 0;
  let issued = 0;
  const requests = [];
  const provider = new ChannelProvider({ verifyDns: false, now: () => now, fetchImpl: async (value, options) => {
    const url = new URL(value);
    requests.push({ url, headers: options.headers });
    if (url.hostname === 'dembed.st') return new Response(player());
    if (url.pathname === '/api/playlist-token') return tokenReply(`fixture-${++issued}`);
    if (url.pathname.endsWith('/index.m3u8')) return new Response(manifest);
    if (url.pathname.endsWith('/variant.m3u8')) return new Response(mediaList);
    if (url.pathname.endsWith('/key.bin')) return new Response('key');
    throw new Error('Unexpected request');
  } });
  t.after(() => provider.close());

  const first = await provider.getPlaylist('339');
  assert.doesNotMatch(first.body.toString(), /fixture-|https?:/);
  const variant = resource(first);
  now = 59_000;
  const nested = await provider.getMedia(variant);
  assert.equal(issued, 1);
  now = 60_001;
  await provider.getMedia(variant);
  assert.equal(issued, 2, 'nested playlist refreshes continue renewing after initial tuning');
  const key = nested.body.toString().match(/URI="\/media\/([\w-]+)"/)[1];
  await provider.getMedia(key);

  for (const { url, headers } of requests) {
    const authorized = url.pathname === '/api/playlist-token' || url.pathname.endsWith('.m3u8');
    assert.deepEqual(Object.keys(headers).sort(), authorized ? ['Accept', 'Origin', 'Referer'] : ['Accept']);
    if (authorized) {
      assert.equal(headers.Origin, 'https://dembed.st');
      assert.equal(headers.Referer, 'https://dembed.st/');
    }
    if (url.pathname === '/api/playlist-token') {
      assert.equal(url.searchParams.get('slug'), 'premium339');
      assert.equal(url.searchParams.has('t'), false);
    } else if (url.pathname.endsWith('.m3u8')) {
      assert.match(url.searchParams.get('t'), /^fixture-[12]$/);
      assert.equal(url.searchParams.has('_'), true);
    } else if (url.hostname !== 'dembed.st') assert.equal(url.search, '');
  }
});

test('concurrent playlist loads share token issuance, isolated by channel', async t => {
  const slugs = [];
  const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async value => {
    const url = new URL(value);
    if (url.hostname === 'dembed.st') return new Response(player(url.searchParams.get('id')));
    if (url.pathname === '/api/playlist-token') {
      slugs.push(url.searchParams.get('slug'));
      await new Promise(resolve => setImmediate(resolve));
      return tokenReply();
    }
    return new Response(mediaList);
  } });
  t.after(() => provider.close());
  await Promise.all([provider.getPlaylist('339'), provider.getPlaylist('339'), provider.getPlaylist('310')]);
  assert.deepEqual(slugs.sort(), ['premium310', 'premium339']);
});

test('an expired playlist token is replaced once after 403, without unbounded source reloads', async t => {
  let issued = 0;
  let playlists = 0;
  let pages = 0;
  let failAlways = false;
  const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async value => {
    const url = new URL(value);
    if (url.hostname === 'dembed.st') { pages++; return new Response(player()); }
    if (url.pathname === '/api/playlist-token') return tokenReply(`fixture-${++issued}`);
    playlists++;
    return !failAlways && url.searchParams.get('t') === 'fixture-2'
      ? new Response(mediaList) : new Response('denied', { status: 403 });
  } });
  t.after(() => provider.close());
  await provider.getPlaylist('339');
  assert.equal(issued, 2);
  assert.equal(playlists, 2);
  failAlways = true;
  await assert.rejects(provider.getPlaylist('339'), error => error.upstreamStatus === 403);
  assert.equal(issued, 3);
  assert.equal(playlists, 4);
  assert.equal(pages, 1);
  assert.equal(provider.playlistTokens.size, 0);
});

test('a transient renewal failure uses the still-valid token briefly, but never after its validity window', async t => {
  let now = 0;
  let issued = 0;
  const seen = [];
  const provider = new ChannelProvider({ verifyDns: false, now: () => now, fetchImpl: async value => {
    const url = new URL(value);
    if (url.hostname === 'dembed.st') return new Response(player());
    if (url.pathname === '/api/playlist-token') return ++issued === 1 ? tokenReply() : new Response('unavailable', { status: 503 });
    seen.push(url.searchParams.get('t'));
    return new Response(mediaList);
  } });
  t.after(() => provider.close());
  await provider.getPlaylist('339');
  now = 61_000;
  await provider.getPlaylist('339');
  now = 62_000;
  await provider.getPlaylist('339');
  assert.equal(issued, 2, 'a failed renewal does not hammer the endpoint');
  now = 108_000;
  await assert.rejects(provider.getPlaylist('339'), error => error.upstreamStatus === 503);
  assert.equal(seen.length, 3);
});

test('main token metadata must match the configured channel and source edge without evaluating scripts', async t => {
  for (const html of [
    player().replace("CHANNEL = 'premium339'", "CHANNEL = 'premium310'"),
    player().replace(`EDGE = '${edge}'`, "EDGE = 'https://attacker.example'"),
    player().replace("CHANNEL = 'premium339';", 'CHANNEL = executeCode();'),
  ]) {
    let requests = 0;
    const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async () => { requests++; return new Response(html); } });
    t.after(() => provider.close());
    await assert.rejects(provider.getPlaylist('339'), error => error.code === 'SOURCE_CHANGED');
    assert.equal(requests, 1);
  }
});

test('token issuance rejects malformed and oversized replies and does not fetch a playlist', async t => {
  for (const reply of [() => new Response('{bad'), () => Response.json({ token: {} }), () => tokenReply('line\nbreak'), () => tokenReply('x'.repeat(20_000))]) {
    let requests = 0;
    const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async value => {
      requests++;
      return new URL(value).hostname === 'dembed.st' ? new Response(player()) : reply();
    } });
    t.after(() => provider.close());
    await assert.rejects(provider.getPlaylist('339'), error => ['INVALID_PLAYLIST_TOKEN', 'RESPONSE_TOO_LARGE'].includes(error.code));
    assert.equal(requests, 2);
  }
});

test('token endpoints and authorized playlists reject redirects before forwarding context or tokens', async t => {
  for (const redirectToken of [true, false]) {
    const requests = [];
    const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async value => {
      const url = new URL(value);
      requests.push(url.hostname);
      if (url.hostname === 'dembed.st') return new Response(player());
      if (url.pathname === '/api/playlist-token' && !redirectToken) return tokenReply();
      return new Response('', { status: 302, headers: { location: redirectToken ? `${edge}/different-token-endpoint` : 'https://v16-a.tiktokcdn-us.com/leaked.m3u8' } });
    } });
    t.after(() => provider.close());
    await assert.rejects(provider.getPlaylist('339'), error => error.code === 'BLOCKED_SOURCE');
    assert.equal(requests.includes('v16-a.tiktokcdn-us.com'), false);
    assert.equal(requests.length, redirectToken ? 2 : 3);
  }
});

test('playlist authorization never attaches to a registered carrier URL', async t => {
  const requests = [];
  const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async (url, options) => {
    requests.push({ url, headers: options.headers });
    if (url.startsWith('https://dembed.st/')) return new Response(player());
    if (url.includes('/api/playlist-token?')) return tokenReply();
    return new Response('#EXTM3U\n');
  } });
  t.after(() => provider.close());
  await provider.getPlaylist('339');
  const auth = provider.sourceCache.get('339\nstream').playlistAuth;
  const url = 'https://v16-a.tiktokcdn-us.com/audio.m3u8?signature=original';
  const id = provider.register(url, 'playlist', edge, '339', 'stream', auth).split('/').pop();
  await provider.getMedia(id);
  assert.deepEqual(requests.at(-1), { url, headers: { Accept: '*/*' } });
});

test('a forced retry sharing a failed renewal never receives its ordinary caller fallback', async t => {
  let now = 0;
  let issued = 0;
  let playlists = 0;
  let releaseOldPlaylist;
  let releaseRenewal;
  let oldPlaylistStarted;
  let renewalStarted;
  const oldStarted = new Promise(resolve => { oldPlaylistStarted = resolve; });
  const renewalBegan = new Promise(resolve => { renewalStarted = resolve; });
  const provider = new ChannelProvider({ verifyDns: false, now: () => now, fetchImpl: async value => {
    const url = new URL(value);
    if (url.hostname === 'dembed.st') return new Response(player());
    if (url.pathname === '/api/playlist-token') {
      if (++issued === 1) return tokenReply('fixture-old');
      renewalStarted();
      return new Promise(resolve => { releaseRenewal = resolve; });
    }
    if (++playlists === 2) {
      oldPlaylistStarted();
      return new Promise(resolve => { releaseOldPlaylist = resolve; });
    }
    return new Response(mediaList);
  } });
  t.after(() => provider.close());

  await provider.getPlaylist('339');
  now = 59_000;
  const oldPlaylist = provider.getPlaylist('339');
  await oldStarted;
  now = 61_000;
  const auth = provider.sourceCache.get('339\nstream').playlistAuth;
  const ordinaryRenewal = provider.playlistToken(auth);
  await renewalBegan;
  const rejected = assert.rejects(oldPlaylist, error => error.upstreamStatus === 503);
  releaseOldPlaylist(new Response('denied', { status: 403 }));
  await new Promise(resolve => setImmediate(resolve));
  releaseRenewal(new Response('temporarily unavailable', { status: 503 }));

  assert.equal(await ordinaryRenewal, 'fixture-old', 'an ordinary caller retains its allowed temporary fallback');
  await rejected;
  assert.equal(issued, 2, 'both callers shared the same network renewal');
  assert.equal(playlists, 2, 'the forced caller did not send the known rejected token again');
});

test('a late old-token rejection preserves a newer token for concurrent ordinary playback', async t => {
  let issued = 0;
  let oldPlaylists = 0;
  let releaseLatePlaylist;
  let releaseForcedRenewal;
  let latePlaylistStarted;
  let forcedRenewalStarted;
  const lateStarted = new Promise(resolve => { latePlaylistStarted = resolve; });
  const forcedBegan = new Promise(resolve => { forcedRenewalStarted = resolve; });
  const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async value => {
    const url = new URL(value);
    if (url.hostname === 'dembed.st') return new Response(player());
    if (url.pathname === '/api/playlist-token') {
      issued++;
      if (issued < 3) return tokenReply(`fixture-${issued}`);
      forcedRenewalStarted();
      return new Promise(resolve => { releaseForcedRenewal = resolve; });
    }
    if (url.searchParams.get('t') === 'fixture-1') {
      if (++oldPlaylists === 2) {
        latePlaylistStarted();
        return new Promise(resolve => { releaseLatePlaylist = resolve; });
      }
      if (oldPlaylists > 2) return new Response('denied', { status: 403 });
    }
    return new Response(mediaList);
  } });
  t.after(() => provider.close());

  await provider.getPlaylist('339');
  const latePlaylist = provider.getPlaylist('339');
  await lateStarted;
  await provider.getPlaylist('339'); // A different rejection already replaced fixture-1.
  releaseLatePlaylist(new Response('denied', { status: 403 }));
  await forcedBegan;
  let ordinaryCompleted = false;
  const ordinary = provider.getPlaylist('339').then(() => { ordinaryCompleted = true; });
  await new Promise(resolve => setImmediate(resolve));
  const continuedBeforeForcedRenewal = ordinaryCompleted;
  releaseForcedRenewal(tokenReply('fixture-3'));
  await Promise.all([latePlaylist, ordinary]);

  assert.equal(continuedBeforeForcedRenewal, true, 'ordinary playback can still use the newer valid cached token');
  assert.equal(issued, 3);
});
