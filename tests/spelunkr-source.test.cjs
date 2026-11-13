'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLineup, parseManifest, archiveUrl, playbackAt, guideAt, CHANNEL_SLUG, LINEUP_URL } = require('../lib/spelunkr-source.cjs');
const { ChannelProvider } = require('../lib/provider.cjs');
const { createServer } = require('../server.cjs');

const epoch = 1700000000000;
const version = { v: 2, epochMs: epoch, effectiveAtMs: epoch, startIndex: 1, manifest: `manifests/${CHANNEL_SLUG}/v2.json` };
const lineup = () => ({ engine: 5, channels: [{ id: CHANNEL_SLUG, dial: 54, versions: [{ ...version }] }] });
const manifest = () => ({ engine: 5, channel: CHANNEL_SLUG, version: 2, items: [
  { id: 'fixture-one', mp4: 'one.mp4', title: 'First block', duration: 20 },
  { id: 'fixture-two', file: 'folder/Tape #2 & more.mp4', title: 'Second block', duration: 10, inS: 50, outS: 60 },
] });
const schedule = () => parseManifest(manifest(), parseLineup(lineup(), epoch));

test('archive rotation honors the first start index, trim, subsequent full cycles and exact boundaries', () => {
  const data = schedule();
  const current = playbackAt(data, epoch + 3000);
  assert.equal(current.programTitle, 'Second block');
  assert.equal(current.startTime, 53);
  assert.equal(current.trimStart, 50); assert.equal(current.trimEnd, 60);
  assert.equal(current.startsAt, epoch); assert.equal(current.endsAt, epoch + 10000);
  assert.equal(current.serverTime, epoch + 3000);
  assert.equal(current.nextProgramTitle, 'First block');
  assert.match(current.scheduleNote, /own rotation/);
  assert.equal(playbackAt(data, epoch + 10000).programTitle, 'First block');
  assert.equal(playbackAt(data, epoch + 30000).programTitle, 'Second block');
  assert.equal(playbackAt(data, epoch + 40000).programTitle, 'First block');
  assert.equal(playbackAt(data, epoch + 3e12 + 13000).startTime, 3);
});

test('archive paths construct only canonical HTTPS archive downloads and encode literal punctuation', () => {
  assert.equal(archiveUrl('fixture-two', 'folder/Tape #2 & more.mp4'), 'https://archive.org/download/fixture-two/folder/Tape%20%232%20%26%20more.mp4');
  for (const [id, file] of [['https://attacker.example', 'a.mp4'], ['..', 'a.mp4'], ['fixture', '../a.mp4'],
    ['fixture', 'x/./a.mp4'], ['fixture', '/a.mp4'], ['fixture', 'x\\a.mp4'], ['fixture', 'a.m3u8'], ['fixture', 'a.mp4\n']]) {
    assert.throws(() => archiveUrl(id, file));
  }
  assert.equal(new URL(archiveUrl('fixture', 'a%2f.mp4')).pathname, '/download/fixture/a%252f.mp4');
});

test('the archive guide is bounded and describes the exact same trimmed recording transitions as playback', () => {
  const data = schedule();
  const guide = guideAt(data, epoch + 3000);
  const row = guide.channels[0];
  assert.equal(guide.status, 'ready'); assert.equal(row.id, '1054');
  assert.equal(row.programmes.length, 128, 'short test blocks stop at the programme count limit');
  assert.equal(guide.from, epoch); assert.equal(guide.until, row.programmes.at(-1).end);
  assert.doesNotMatch(JSON.stringify(guide), /archive\.org\/download|fixture-two/);
  for (let i = 0; i < row.programmes.length; i++) {
    const programme = row.programmes[i];
    const playback = playbackAt(data, programme.start);
    assert.match(programme.id, /^[a-f0-9]{24}$/);
    assert.equal(programme.channelId, '1054'); assert.equal(programme.start, playback.startsAt);
    assert.equal(programme.end, playback.endsAt); assert.equal(programme.title, playback.programTitle);
    if (i) assert.equal(programme.start, row.programmes[i - 1].end);
  }
  assert.deepEqual(guideAt(data, epoch + 3000), guide, 'stable programme identities survive refreshes');
});

test('only the public channel 54 manifest version is accepted and source data is bounded', () => {
  for (const mutate of [data => { data.engine = 6; }, data => { data.channels[0].dial = 53; },
    data => { data.channels.push({ ...data.channels[0] }); }, data => { data.channels[0].versions[0].manifest = 'https://attacker.example/a.json'; },
    data => { data.channels[0].versions[0].startIndex = 999; }, data => { data.channels[0].versions.push({ ...version }); },
    data => { data.channels[0].versions[0].epochMs = epoch + 1; }]) {
    const data = lineup(); mutate(data); assert.throws(() => parseLineup(data, epoch));
  }
  for (const mutate of [data => { data.channel = 'other'; }, data => { data.version = 1; },
    data => { data.items = Array(513).fill(data.items[0]); }, data => { data.items[0].duration = 0; },
    data => { data.items[1].outS = 80; }, data => { data.items[0].mp4 = '../a.mp4'; }]) {
    const data = manifest(); mutate(data); assert.throws(() => parseManifest(data, parseLineup(lineup(), epoch)));
  }
});

test('archive playback exposes a separate feed and coalesces/cache-refreshes its fixed schedule requests', async t => {
  let now = epoch + 3000;
  const requests = [];
  const p = new ChannelProvider({ verifyDns: false, now: () => now, sourceTtlMs: 1000, fetchImpl: async (url, options) => {
    requests.push({ url, options }); await new Promise(setImmediate);
    return Response.json(url === LINEUP_URL ? lineup() : manifest());
  } });
  t.after(() => p.close());
  const metadata = p.listChannels().find(channel => channel.id === '1054');
  assert.equal(metadata.playbackType, 'file'); assert.equal(metadata.defaultFeed, 'spelunkr');
  assert.deepEqual(metadata.feeds.map(feed => feed.id), ['spelunkr']);
  assert.equal(p.feed('1054').id, 'spelunkr');
  await assert.rejects(p.getPlaylist('1054'), error => error.code === 'UNSUPPORTED_PLAYBACK');
  await assert.rejects(p.getPlayback('339'), error => error.code === 'UNSUPPORTED_PLAYBACK');
  const [first, second] = await Promise.all([p.getPlayback('1054'), p.getPlayback('1054')]);
  assert.deepEqual(first, second); assert.equal(requests.length, 2);
  assert.equal(first.type, 'file'); assert.match(first.url, /^https:\/\/archive\.org\/download\//);
  const guide = await p.getArchiveGuide();
  assert.equal(guide.channels[0].programmes[0].title, first.programTitle);
  assert.equal(requests.length, 2, 'guide shares the playback schedule cache');
  now += 500; assert.equal((await p.getPlayback('1054')).startTime, 53.5); assert.equal(requests.length, 2);
  now += 501; await p.getPlayback('1054'); assert.equal(requests.length, 4);
  for (const { url, options } of requests) {
    assert.ok([LINEUP_URL, `https://spelunkr.tv/broadcast/${version.manifest}`].includes(url));
    assert.deepEqual(options.headers, { Accept: '*/*' }); assert.equal(options.redirect, 'manual');
  }
});

test('archive redirects, private DNS and invalid JSON fail without unrelated network requests or response leakage', async t => {
  for (const mode of ['redirect', 'dns', 'invalid']) {
    let requests = 0;
    const p = new ChannelProvider({ now: () => epoch, verifyDns: mode === 'dns', resolveHost: async () => [{ address: '127.0.0.1' }], fetchImpl: async () => {
      requests++;
      if (mode === 'redirect') return new Response('', { status: 302, headers: { location: 'https://attacker.example/schedule.json' } });
      return new Response('private-fixture-content');
    } });
    t.after(() => p.close());
    await assert.rejects(p.getPlayback('1054'), error => ['BLOCKED_SOURCE', 'SOURCE_CHANGED'].includes(error.code) && !/attacker|private-fixture/.test(error.message));
    assert.equal(requests, mode === 'dns' ? 0 : 1);
  }
});

test('archive descriptor is served through the local API with media-only archive CSP permission', async t => {
  const descriptor = playbackAt(schedule(), epoch + 3000);
  const server = createServer({ provider: { getPlayback: async id => { assert.equal(id, '1054'); return descriptor; }, close() {} }, updates: { close() {} }, guide: { close() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/channels/1054/playback`);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), descriptor);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /media-src 'self' blob: https:\/\/archive\.org https:\/\/\*\.archive\.org;/);
  assert.match(csp, /script-src 'self';/); assert.match(csp, /connect-src 'self';/); assert.match(csp, /frame-src 'none';/);
});
