'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, STORAGE_KEY, episodeKey } = require('../public/watch-history.js');

function fixture(initial) {
  const values = new Map(initial ? [[STORAGE_KEY, initial]] : []);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  let clock = 100000;
  return { storage, values, create: () => createStore({ storage, now: () => clock }), advance: ms => { clock += ms; } };
}
const episode = extras => ({ title: 'Example Show', subtitle: 'The First Episode', episode: 'S01E02', start: 100000, end: 200000, ...extras });
function watch(store, programme, start, end) { for (let from = start; from < end; from += 5000) store.recordCoverage(programme, from, Math.min(end, from + 5000)); }

test('episode identities survive reruns, channels, case and zero padding without conflating episodes or unidentified blocks', () => {
  assert.equal(episodeKey(episode()), episodeKey(episode({ title: ' EXAMPLE SHOW ', episode: 's1e2', channelId: 'different', start: 900000 })));
  assert.notEqual(episodeKey(episode()), episodeKey(episode({ episode: 'S01E03' })));
  assert.equal(episodeKey({ title: 'Archive recording' }), null);
  assert.equal(episodeKey({ title: 'Show', subtitle: 'Show' }), null);
  assert.equal(episodeKey({ title: 'Show', subtitle: 'Episode Name' }), episodeKey({ title: 'show', subtitle: 'episode name' }));
});

test('automatic watched state requires eighty percent unique coverage and restores after an app update', () => {
  const f = fixture(), store = f.create(), programme = episode();
  watch(store, programme, 100000, 150000);
  watch(store, programme, 100000, 150000);
  assert.equal(store.isWatched(programme), false, 'replaying half an episode twice is still half');
  watch(store, programme, 150000, 175000);
  assert.equal(store.isWatched(programme), false);
  watch(store, programme, 175000, 180000);
  assert.equal(store.isWatched(programme), true);
  assert.equal(f.create().isWatched(episode({ start: 500000, end: 600000 })), true, 'storage identity does not contain app version or airing date');
  assert.equal(store.getEntries().length, 1);
});

test('partial coverage flushes on pause/close and can accumulate across a later rerun', () => {
  const f = fixture(), programme = episode();
  const first = f.create(); watch(first, programme, 100000, 150000);
  assert.equal(first.flush().ok, true);
  const second = f.create(), rerun = episode({ start: 300000, end: 400000 });
  watch(second, rerun, 350000, 380000);
  assert.equal(second.isWatched(rerun), true);
});

test('manual marks, removals and clear survive reload and notify listeners only after persistence', () => {
  const f = fixture(), store = f.create(); let updates = 0;
  const unsubscribe = store.subscribe(() => updates++);
  assert.equal(store.setWatched(episode()).ok, true);
  assert.equal(f.create().isWatched(episode()), true);
  assert.equal(store.setWatched(episode(), false).ok, true);
  assert.equal(f.create().isWatched(episode()), false);
  store.setWatched(episode()); store.clear();
  assert.deepEqual(f.create().getEntries(), []);
  assert.equal(updates, 4); unsubscribe(); store.clear(); assert.equal(updates, 4);
});

test('seeks, invalid times, unknown episodes and storage failures never produce a saved watched badge', () => {
  const f = fixture(), store = f.create();
  for (const [from, to] of [[100000, 180000], [200000, 100000], [NaN, 180000], [Infinity, Infinity]]) assert.equal(store.recordCoverage(episode(), from, to).ok, false);
  assert.equal(store.setWatched({ title: 'Unidentified archive block' }).ok, false);
  f.storage.setItem = () => { throw new Error('quota'); };
  assert.equal(store.setWatched(episode()).ok, false);
  assert.equal(store.isWatched(episode()), false);
  watch(store, episode(), 100000, 180000);
  assert.equal(store.isWatched(episode()), false);
});

test('corrupt and unsupported history stays bounded and never becomes watched by accident', () => {
  for (const raw of ['{', 'null', JSON.stringify({ version: 2, items: [] }), 'x'.repeat(2 * 1024 * 1024 + 1), JSON.stringify({ version: 1, items: [{ title: 'Show', subtitle: 'Episode', updatedAt: 1, coverage: [[0, 1000000]], watchedAt: 'true' }] })]) {
    const f = fixture(raw);
    assert.deepEqual(f.create().getEntries(), []);
  }
});
