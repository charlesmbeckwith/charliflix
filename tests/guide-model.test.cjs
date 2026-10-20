'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createScheduler, STORAGE_KEY, STORAGE_VERSION, MAX_ITEMS, MAX_TITLE, HORIZON_MS, GRACE_MS } = require('../public/guide-model.js');

const base = Date.parse('2026-10-19T12:00:00Z');
const channelIds = ['339', '310', '317'];
const event = (channelId = '339', start = base + 60_000, title = 'A programme') => ({ id: `${channelId}-${start}`, channelId, start, end: start + 30 * 60_000, title });
function memoryStorage(initial = null) {
  let value = initial;
  const calls = [];
  return { calls, getItem(key) { assert.equal(key, STORAGE_KEY); return value; }, setItem(key, next) { assert.equal(key, STORAGE_KEY); calls.push(next); value = next; } };
}
const document = items => JSON.stringify({ version: STORAGE_VERSION, items });

test('the same standalone model loads in a browser global without CommonJS or timers', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/guide-model.js'), 'utf8'), context);
  assert.equal(typeof context.CharliflixGuideModel.createScheduler, 'function');
  const scheduler = context.CharliflixGuideModel.createScheduler({ channelIds, now: () => base });
  assert.equal(scheduler.add(event()).ok, true);
  assert.equal(scheduler.list().length, 1);
});

test('a due tune is removed from storage before execution and never repeats after a callback failure or restart', () => {
  let time = base;
  let tuned = 0;
  const errors = [];
  const storage = memoryStorage();
  const scheduler = createScheduler({ channelIds, storage, now: () => time, onError: error => errors.push(error.message), onTune: item => {
    tuned++;
    assert.equal(item.channelId, '339');
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)).items, []);
    assert.equal(scheduler.list().length, 0);
    assert.deepEqual(scheduler.tick().tuned, [], 'a reentrant tick cannot execute the removed item');
    throw new Error('The feed could not start.');
  } });
  scheduler.add(event());
  assert.equal(scheduler.tick().tuned.length, 0);
  time += 60_000;
  assert.equal(scheduler.tick().tuned.length, 1);
  scheduler.tick();
  assert.equal(tuned, 1);
  assert.deepEqual(errors, ['The feed could not start.']);
  const reopened = createScheduler({ channelIds, storage, now: () => time, onTune: () => tuned++ });
  reopened.tick();
  assert.equal(tuned, 1);
});

test('schedules persist, sort, deduplicate by channel and start, and toggle or cancel without trusting provider IDs', () => {
  const storage = memoryStorage();
  const changes = [];
  let scheduler = createScheduler({ channelIds, storage, now: () => base, onChange: (items, change) => changes.push({ items, change }) });
  const later = event('310', base + 120_000);
  scheduler.add(later);
  scheduler.add(event());
  assert.equal(scheduler.add({ ...event(), id: 'a-new-provider-id', title: 'Updated title' }).duplicate, true);
  assert.equal(scheduler.has('339', String(event().start)), false, 'lookup inputs are not coerced into valid schedule identities');
  assert.equal(scheduler.list().length, 2);
  assert.equal(scheduler.next().channelId, '339');
  const leaked = scheduler.list();
  leaked[0].title = 'Mutated by a caller';
  assert.equal(scheduler.next().title, 'A programme');
  scheduler = createScheduler({ channelIds, storage, now: () => base });
  assert.equal(scheduler.has('339', event().start), true);
  assert.equal(scheduler.toggle(event()).ok, true);
  assert.equal(scheduler.has('339', event().start), false);
  assert.equal(scheduler.cancel(later.channelId, later.start).ok, true);
  assert.equal(scheduler.next(), null);
  assert.equal(scheduler.cancel(later.channelId, later.start).code, 'not-found');
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), { version: STORAGE_VERSION, items: [] });
  assert.equal(changes.length, 2, 'a duplicate does not rewrite or notify the schedule');
});

test('two channels at the same start require explicit replacement and leave existing state intact on conflict', () => {
  const storage = memoryStorage();
  const scheduler = createScheduler({ channelIds, storage, now: () => base });
  const first = event();
  const second = event('310', first.start);
  scheduler.add(first);
  assert.deepEqual(scheduler.add(second), { ok: false, code: 'conflict', conflict: first });
  assert.equal(storage.calls.length, 1);
  const replaced = scheduler.add(second, { replace: true });
  assert.deepEqual(replaced.replaced, first);
  assert.deepEqual(scheduler.list(), [second]);
  assert.equal(scheduler.toggle(second).ok, true);
  assert.equal(scheduler.list().length, 0);
});

test('on wake the latest due still-airing programme wins and earlier due programmes become superseded', () => {
  const first = event('339', base + 60_000);
  const second = event('310', base + 120_000);
  const future = event('317', base + 600_000);
  const storage = memoryStorage(document([future, first, second]));
  const played = [];
  const missed = [];
  const scheduler = createScheduler({ channelIds, storage, now: () => base + 180_000, onTune: item => played.push(item), onMissed: items => missed.push(...items) });
  const result = scheduler.tick();
  assert.deepEqual(played, [second]);
  assert.deepEqual(result.tuned, [second]);
  assert.deepEqual(missed, [{ ...first, reason: 'superseded' }]);
  assert.deepEqual(scheduler.list(), [future]);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)).items, [future]);
});

test('sleep and reopen recovery honor the five-minute grace and never tune an ended programme', () => {
  const eligible = event('339', base);
  const late = event('310', base - 1);
  const ended = { ...event('317', base + 1), end: base + GRACE_MS };
  const scheduler = createScheduler({ channelIds, storage: memoryStorage(document([eligible, late, ended])), now: () => base + GRACE_MS });
  const result = scheduler.tick();
  assert.deepEqual(result.tuned, [eligible], 'the grace boundary is inclusive while the programme end is exclusive');
  assert.deepEqual(result.missed.map(({ channelId, reason }) => ({ channelId, reason })), [{ channelId: '310', reason: 'late' }, { channelId: '317', reason: 'ended' }]);
  assert.deepEqual(scheduler.list(), []);
});

test('corrupt, oversized and unsupported localStorage documents are ignored safely', () => {
  for (const value of ['{bad', 'null', '[]', document(null), JSON.stringify({ version: 99, items: [event()] }), ' '.repeat(64 * 1024 + 1)]) {
    const scheduler = createScheduler({ channelIds, storage: memoryStorage(value), now: () => base });
    assert.deepEqual(scheduler.list(), []);
  }
  const scheduler = createScheduler({ channelIds, now: () => base, storage: { getItem() { throw new Error('Access denied'); }, setItem() { throw new Error('Access denied'); } } });
  assert.deepEqual(scheduler.list(), []);
  assert.equal(scheduler.add(event()).code, 'storage');
});

test('restoration filters unknown channels, invalid times and conflicting starts, and bounds stored event text', () => {
  const valid = event();
  const raw = [
    { ...valid, channelId: 'https://untrusted.example' },
    { ...valid, start: String(valid.start) },
    { ...valid, end: valid.start },
    { ...valid, start: Infinity },
    { ...valid, end: valid.start + HORIZON_MS + 1 },
    { ...valid, title: {} },
    { ...valid, title: '\u0000\n' },
    { ...valid, title: '\u0000  <img src=x onerror=alert(1)>\n' + 'x'.repeat(500), executable: 'discarded' },
    event('310', valid.start),
  ];
  const scheduler = createScheduler({ channelIds, storage: memoryStorage(document(raw)), now: () => base });
  assert.equal(scheduler.list().length, 1);
  assert.equal(scheduler.next().channelId, '339');
  assert.equal(scheduler.next().title.length, MAX_TITLE);
  assert.equal(scheduler.next().title.startsWith('<img src=x onerror=alert(1)> '), true, 'titles remain literal text for textContent rendering');
  assert.equal(scheduler.next().executable, undefined);
});

test('new schedules require configured channels, finite epoch milliseconds and the next seven-day window', () => {
  const scheduler = createScheduler({ channelIds, now: () => base });
  for (const invalid of [null, [], { ...event(), channelId: '210' }, { ...event(), start: NaN }, { ...event(), start: new Date(base) }, { ...event(), end: Number.MAX_SAFE_INTEGER + 1 }, { ...event(), end: 0 }, { ...event(), title: '' }]) {
    assert.equal(scheduler.add(invalid).ok, false);
  }
  assert.equal(scheduler.add(event('339', base - 1)).code, 'past');
  assert.equal(scheduler.add(event('339', base + HORIZON_MS)).code, 'too-far', 'the complete programme must fit the bounded scheduling window');
  assert.equal(scheduler.add({ ...event(), start: base + HORIZON_MS - 1, end: base + HORIZON_MS }).ok, true);
});

test('capacity stays bounded for new schedules and restored storage while replacement remains available', () => {
  const scheduler = createScheduler({ channelIds, now: () => base });
  const entries = Array.from({ length: MAX_ITEMS + 10 }, (_, index) => event('339', base + (index + 1) * 60_000));
  for (const item of entries.slice(0, MAX_ITEMS)) assert.equal(scheduler.add(item).ok, true);
  assert.equal(scheduler.add(entries[MAX_ITEMS]).code, 'limit');
  assert.equal(scheduler.add({ ...entries[0], channelId: '310' }, { replace: true }).ok, true);
  const restored = createScheduler({ channelIds, now: () => base, storage: memoryStorage(document(entries)) });
  assert.equal(restored.list().length, MAX_ITEMS);
});

test('a failed storage write never changes the queue or executes a tune until removal can be persisted', () => {
  let time = base;
  let fail = false;
  let tuned = 0;
  const store = memoryStorage();
  const scheduler = createScheduler({ channelIds, now: () => time, onTune: () => tuned++, storage: { getItem: key => store.getItem(key), setItem(key, value) { if (fail) throw new Error('Storage full'); store.setItem(key, value); } } });
  scheduler.add(event());
  fail = true;
  assert.equal(scheduler.cancel('339', event().start).code, 'storage');
  assert.equal(scheduler.list().length, 1);
  time = event().start;
  assert.equal(scheduler.tick().code, 'storage');
  assert.equal(tuned, 0);
  assert.equal(scheduler.list().length, 1);
  fail = false;
  assert.equal(scheduler.tick().tuned.length, 1);
  assert.equal(tuned, 1);
  assert.deepEqual(scheduler.list(), []);
});

test('players sharing storage refresh before mutations and ticks so cancellations and other additions are preserved', () => {
  let time = base;
  const storage = memoryStorage();
  let tuned = 0;
  const first = createScheduler({ channelIds, storage, now: () => time, onTune: () => tuned++ });
  const second = createScheduler({ channelIds, storage, now: () => time, onTune: () => tuned++ });
  const a = event();
  const b = event('310', base + 120_000);
  first.add(a);
  second.add(b);
  assert.deepEqual(second.list(), [a, b], 'a stale player must preserve another player\'s addition');
  first.cancel(a.channelId, a.start);
  assert.deepEqual(first.list(), [b], 'cancellation must preserve changes made by the other player');
  time = a.start;
  second.tick();
  assert.equal(tuned, 0, 'the stale player must not tune the canceled item');
  time = b.start;
  first.tick();
  second.tick();
  assert.equal(tuned, 1, 'serialized ticks observe the prior player\'s persisted removal');
  assert.deepEqual(second.list(), []);
});

test('explicit storage refresh notifies only an actual queue change and never writes the shared store', () => {
  const storage = memoryStorage();
  const changes = [];
  const scheduler = createScheduler({ channelIds, storage, now: () => base, onChange: (items, change) => changes.push({ items, change }) });
  assert.equal(changes.length, 0);
  assert.deepEqual(scheduler.refresh(), { ok: true, changed: false });
  storage.setItem(STORAGE_KEY, document([event()]));
  assert.deepEqual(scheduler.refresh(), { ok: true, changed: true });
  assert.deepEqual(changes, [{ items: [event()], change: { reason: 'refresh' } }]);
  scheduler.refresh();
  assert.equal(changes.length, 1);
  assert.equal(storage.calls.length, 1, 'a refresh cannot create storage-event write loops');
});

test('a failed shared-storage read prevents stale writes and stale execution', () => {
  let time = base;
  let fail = false;
  let tuned = 0;
  const store = memoryStorage();
  const scheduler = createScheduler({ channelIds, now: () => time, onTune: () => tuned++, storage: { getItem(key) { if (fail) throw new Error('Storage unavailable'); return store.getItem(key); }, setItem: (key, value) => store.setItem(key, value) } });
  scheduler.add(event());
  const writes = store.calls.length;
  fail = true;
  assert.equal(scheduler.add(event('310', base + 120_000)).code, 'storage');
  assert.equal(scheduler.cancel('339', event().start).code, 'storage');
  time = event().start;
  assert.equal(scheduler.tick().code, 'storage');
  assert.equal(store.calls.length, writes);
  assert.equal(tuned, 0);
});

test('UTC timestamps remain distinct across the repeated local hour at the daylight-saving transition', () => {
  let time = Date.parse('2026-11-01T08:00:00Z');
  const earlier = event('339', Date.parse('2026-11-01T08:30:00Z'));
  const later = event('310', Date.parse('2026-11-01T09:30:00Z'));
  const played = [];
  const scheduler = createScheduler({ channelIds, now: () => time, onTune: item => played.push(item.channelId) });
  assert.equal(scheduler.add(earlier).ok, true);
  assert.equal(scheduler.add(later).ok, true);
  time = earlier.start;
  scheduler.tick();
  assert.deepEqual(played, ['339']);
  assert.deepEqual(scheduler.list(), [later]);
  time = later.start;
  scheduler.tick();
  assert.deepEqual(played, ['339', '310']);
});
