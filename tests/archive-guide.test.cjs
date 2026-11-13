'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeArchiveGuide } = require('../lib/guide-composition.cjs');
const { createServer } = require('../server.cjs');

const normal = status => ({ status, from: status === 'unavailable' ? null : 1000, until: status === 'unavailable' ? null : 5000,
  source: { name: 'EPGTalk' }, channels: [
    { id: '339', status: 'ready', programmes: [{ start: 1000, end: 5000, title: 'Cartoons' }] },
    { id: '1054', status: 'unmapped', programmes: [], reason: 'Affiliate unknown' },
  ] });
const archive = () => ({ status: 'ready', from: 2000, until: 10000, fetchedAt: 3000, updatedAt: 2000,
  channels: [{ id: '1054', status: 'ready', listingName: 'Spelunkr 54 archive rotation', scheduleNote: 'Charliflix uses its own rotation.',
    programmes: [{ id: 'archive-fixture', channelId: '1054', start: 2000, end: 7000, title: 'Archive block' }] }] });

test('guide composition replaces only the archive row without mutating the normal EPG snapshot', () => {
  const base = normal('ready'), original = structuredClone(base);
  const result = mergeArchiveGuide(base, archive());
  assert.deepEqual(base, original);
  assert.deepEqual(result.channels[0], base.channels[0]);
  assert.equal(result.channels[1].status, 'ready');
  assert.equal(result.channels.filter(row => row.id === '1054').length, 1);
  assert.equal(result.status, 'ready'); assert.equal(result.partial, false);
  assert.equal(result.from, 1000); assert.equal(result.until, 10000);
  result.channels[0].programmes[0].title = 'mutated';
  assert.equal(base.channels[0].programmes[0].title, 'Cartoons');
});

test('either guide source can fail independently without erasing the other source listings', () => {
  const archiveOnly = mergeArchiveGuide(normal('unavailable'), archive());
  assert.equal(archiveOnly.status, 'ready'); assert.equal(archiveOnly.partial, true);
  assert.equal(archiveOnly.from, 2000); assert.equal(archiveOnly.until, 10000);
  assert.equal(archiveOnly.channels.find(row => row.id === '1054').programmes[0].title, 'Archive block');
  const normalOnly = mergeArchiveGuide(normal('ready'), null);
  assert.equal(normalOnly.status, 'ready'); assert.equal(normalOnly.partial, true);
  assert.equal(normalOnly.channels[0].programmes[0].title, 'Cartoons');
  const failedArchive = normalOnly.channels.find(row => row.id === '1054');
  assert.equal(failedArchive.status, 'unavailable');
  assert.doesNotMatch(failedArchive.reason, /affiliate/i);
  const bothFailed = mergeArchiveGuide(normal('unavailable'), null);
  assert.equal(bothFailed.status, 'unavailable');
});

test('the guide API loads its independent sources concurrently and isolates either rejection', async t => {
  for (const failed of ['normal', 'archive']) {
    const started = [];
    let notifyStarted;
    const bothStarted = new Promise(resolve => { notifyStarted = resolve; });
    const markStarted = name => { started.push(name); if (started.length === 2) notifyStarted(); };
    let resolveNormal, resolveArchive;
    const normalPending = new Promise((resolve, reject) => { resolveNormal = () => failed === 'normal' ? reject(new Error('EPG unavailable')) : resolve(normal('ready')); });
    const archivePending = new Promise((resolve, reject) => { resolveArchive = () => failed === 'archive' ? reject(new Error('Archive unavailable')) : resolve(archive()); });
    const server = createServer({
      guide: { check() { markStarted('normal'); return normalPending; }, snapshot: () => normal('unavailable') },
      provider: { getArchiveGuide() { markStarted('archive'); return archivePending; } }, updates: {},
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const request = fetch(`http://127.0.0.1:${server.address().port}/api/guide`);
    let deadline;
    try { await Promise.race([bothStarted, new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Guide reads did not start')), 2000); })]); }
    finally { clearTimeout(deadline); }
    assert.deepEqual(started, ['normal', 'archive'], 'both reads start before either resolves');
    resolveNormal(); resolveArchive();
    const response = await request;
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 'ready'); assert.equal(result.partial, true);
    assert.equal(result.channels.find(row => row.id === '1054').status, failed === 'archive' ? 'unavailable' : 'ready');
    assert.equal(result.channels[0].programmes[0].title, 'Cartoons');
  }
});
