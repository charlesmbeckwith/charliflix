'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelProvider, parseSourceUrl } = require('../lib/provider.cjs');

const edge = 'https://edge.wedd48c.top';
const player = (id = '339', origin = edge) => `
  const SRC = '${origin}/premium${id}/index.m3u8';
  const CHANNEL = 'premium${id}'; const EDGE = '${origin}';
  fetch(EDGE + '/api/playlist-token?slug=' + encodeURIComponent(CHANNEL));`;
const resources = output => [...output.body.toString().matchAll(/\/media\/([A-Za-z0-9_-]{32})/g)].map(match => match[1]);

test('primary migration accepts only the observed top edge while retaining legacy sbs edges', () => {
  assert.equal(parseSourceUrl(player()), `${edge}/premium339/index.m3u8`);
  assert.equal(parseSourceUrl(player('310', 'https://edge-2.fixture.sbs')), 'https://edge-2.fixture.sbs/premium310/index.m3u8');
  for (const origin of [
    'https://edge.other.top', 'https://edge2.wedd48c.top', 'https://sub.edge.wedd48c.top',
    'https://edge.wedd48c.top.attacker.example', 'https://edge.wedd48c.top:8443',
    'https://user:secret@edge.wedd48c.top', 'http://edge.wedd48c.top',
  ]) assert.throws(() => parseSourceUrl(player('339', origin)), error => error.code === 'BLOCKED_SOURCE', origin);
});

test('migrated primary edge renews anonymous authorization for rewritten nested playlists without sending it to keys', async t => {
  let now = 0, issued = 0;
  const requests = [];
  const provider = new ChannelProvider({ verifyDns: false, now: () => now, fetchImpl: async (value, options) => {
    const url = new URL(value);
    requests.push({ url, options });
    if (url.hostname === 'dembed.st') return new Response(player());
    assert.equal(url.origin, edge);
    if (url.pathname === '/api/playlist-token') return Response.json({ token: `migration-fixture-${++issued}`, ttl: 120 });
    if (url.pathname === '/premium339/index.m3u8') return new Response('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nvideo/index.m3u8\n');
    if (url.pathname.endsWith('/index.m3u8')) return new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nsegment.ts\n');
    if (url.pathname.endsWith('/key.bin')) return new Response('fixture-key');
    throw new Error('Unexpected migrated-edge request');
  } });
  t.after(() => provider.close());

  const master = await provider.getPlaylist('339');
  assert.doesNotMatch(master.body.toString(), /https?:|migration-fixture-/);
  const [audio, video] = resources(master);
  assert.ok(audio && video);
  now = 59_000;
  await provider.getMedia(video);
  assert.equal(issued, 1);
  now = 60_001;
  const audioList = await provider.getMedia(audio);
  await provider.getMedia(video);
  assert.equal(issued, 2, 'nested video and audio share the renewed authorization');
  const [key] = resources(audioList);
  assert.equal((await provider.getMedia(key)).body.toString(), 'fixture-key');

  const playlists = requests.filter(({ url }) => url.pathname.endsWith('.m3u8'));
  assert.deepEqual(playlists.map(({ url }) => url.searchParams.get('t')), ['migration-fixture-1', 'migration-fixture-1', 'migration-fixture-2', 'migration-fixture-2']);
  assert.equal(requests.filter(({ url }) => url.hostname === 'dembed.st').length, 1);
  for (const { url, options } of requests) {
    const authorized = url.pathname === '/api/playlist-token' || url.pathname.endsWith('.m3u8');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, undefined);
    assert.deepEqual(Object.keys(options.headers).sort(), authorized ? ['Accept', 'Origin', 'Referer'] : ['Accept']);
    if (authorized) {
      assert.equal(options.headers.Origin, 'https://dembed.st');
      assert.equal(options.headers.Referer, 'https://dembed.st/');
    }
    if (url.pathname === '/api/playlist-token') assert.equal(url.search, '?slug=premium339');
    if (url.pathname.endsWith('/key.bin')) assert.equal(url.search, '');
  }
});

test('migrated edge still requires literal channel and authorization metadata to match its source', async t => {
  for (const html of [
    player().replace("CHANNEL = 'premium339'", "CHANNEL = 'premium310'"),
    player().replace(`EDGE = '${edge}'`, "EDGE = 'https://edge.other.top'"),
    player().replace(`SRC = '${edge}/premium339/`, `SRC = '${edge}/premium310/`),
    player().replace("CHANNEL = 'premium339';", 'CHANNEL = executeUntrustedCode();'),
  ]) {
    let requests = 0;
    const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async value => {
      requests++;
      assert.equal(new URL(value).hostname, 'dembed.st');
      return new Response(html);
    } });
    t.after(() => provider.close());
    await assert.rejects(provider.getPlaylist('339'), error => error.code === 'SOURCE_CHANGED');
    assert.equal(requests, 1, 'invalid metadata cannot request any token or playlist');
  }
});

test('migrated token and playlist redirects cannot forward authorization context outside their exact boundaries', async t => {
  for (const [target, location] of [
    ['token', `${edge}/different-token-endpoint`],
    ['token', 'https://edge.other.top/api/playlist-token?slug=premium339'],
    ['playlist', 'https://v16-a.tiktokcdn-us.com/should-not-receive-token.m3u8'],
    ['playlist', 'https://edge.other.top/premium339/index.m3u8'],
    ['nested', 'https://edge.wedd48c.top.attacker.example/stolen.m3u8'],
  ]) {
    const requests = [];
    const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async value => {
      const url = new URL(value); requests.push(url);
      if (url.hostname === 'dembed.st') return new Response(player());
      assert.equal(url.origin, edge, 'redirect destinations must be rejected before fetching');
      if (url.pathname === '/api/playlist-token' && target !== 'token') return Response.json({ token: 'redirect-fixture', ttl: 120 });
      if (url.pathname === '/premium339/index.m3u8' && target === 'nested') return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nvideo/index.m3u8\n');
      return new Response('', { status: 302, headers: { location } });
    } });
    t.after(() => provider.close());
    if (target === 'nested') {
      const master = await provider.getPlaylist('339');
      await assert.rejects(provider.getMedia(resources(master)[0]), error => error.code === 'BLOCKED_SOURCE');
    } else await assert.rejects(provider.getPlaylist('339'), error => error.code === 'BLOCKED_SOURCE');
    assert.equal(requests.length, target === 'token' ? 2 : target === 'playlist' ? 3 : 4);
  }
});

test('new primary edge rejects private and mixed DNS answers before requesting authorization or media', async t => {
  for (const answers of [[{ address: '127.0.0.1' }], [{ address: '8.8.8.8' }, { address: '::1' }]]) {
    const requests = [];
    const resolved = [];
    const provider = new ChannelProvider({
      resolveHost: async hostname => { resolved.push(hostname); return hostname === 'dembed.st' ? [{ address: '8.8.8.8' }] : answers; },
      fetchImpl: async value => {
        requests.push(value);
        assert.equal(new URL(value).hostname, 'dembed.st');
        return new Response(player());
      },
    });
    t.after(() => provider.close());
    await assert.rejects(provider.getPlaylist('339'), error => error.code === 'BLOCKED_SOURCE');
    assert.deepEqual(resolved, ['dembed.st', 'edge.wedd48c.top']);
    assert.equal(requests.length, 1);
  }
});

test('an unconfigured alternate uses the migrated canonical wrapper and rejects different origins, channels, paths and queries', async t => {
  for (const location of [
    'https://dlive.sx/cast/stream-339.php',
    'https://thedaddy.pk.attacker.example/cast/stream-339.php',
    'https://thedaddy.pk/cast/stream-310.php',
    'https://thedaddy.pk/other/stream-339.php',
    'https://thedaddy.pk/cast/stream-339.php?next=untrusted',
  ]) {
    const requests = [];
    const provider = new ChannelProvider({ verifyDns: false, fetchImpl: async (url, options) => {
      requests.push(url);
      assert.equal(url, 'https://thedaddy.pk/cast/stream-339.php');
      assert.deepEqual(options.headers, { Accept: '*/*', Referer: 'https://thedaddy.pk/' });
      return new Response('', { status: 302, headers: { location } });
    } });
    const originalChannel = provider.channel.bind(provider);
    provider.channel = id => { const { castEmbedId: _unused, ...channel } = originalChannel(id); return channel; };
    t.after(() => provider.close());
    await assert.rejects(provider.sourceFor('339', false, 'cast'), error => error.code === 'BLOCKED_SOURCE');
    assert.equal(requests.length, 1, 'no context is sent to the redirect target');
  }
});
