'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { STORAGE_KEY } = require('../public/guide-model.js');
const modelSource = fs.readFileSync(path.join(__dirname, '../public/guide-model.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(__dirname, '../public/guide-ui.js'), 'utf8');
const base = Date.parse('2026-10-19T12:00:00Z');
const minute = 60_000;
const programme = (channelId = '339', start = base + 30 * minute) => ({ id: `${channelId}:${start}`, channelId, start, end: start + 30 * minute, title: `Programme ${channelId}` });
const listings = () => ({ status: 'ready', from: base - 60 * minute, until: base + 10 * 60 * minute, channels: ['339', '310'].map(id => ({ id, status: 'ready', programmes: [programme(id, base - 15 * minute), programme(id)] })) });

// Exercise the real UI and model together with observable DOM/timer/storage
// adapters. A shared exclusive lock queue models two same-origin browser tabs.
function world(initial = []) {
  let now = base, timerId = 0, tail = Promise.resolve(), activeLocks = 0;
  const storage = new Map(initial.length ? [[STORAGE_KEY, JSON.stringify({ version: 1, items: initial })]] : []);
  const timers = new Map(), writes = [], lockCalls = [];
  const locks = { request(name, callback) {
    lockCalls.push(name);
    const result = tail.then(async () => {
      activeLocks++;
      try { return await callback({ name, mode: 'exclusive' }); }
      finally { activeLocks--; }
    });
    tail = result.catch(() => {});
    return result;
  } };
  const settle = async () => { await new Promise(setImmediate); await tail; await new Promise(setImmediate); };

  async function player({ supported = true, response = listings() } = {}) {
    const nodes = new Map(), windowListeners = {}, documentListeners = {}, tuned = [], fetches = [];
    const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
    const matches = (element, selector) => selector === '[data-programme-key]' ? element.dataset.programmeKey !== undefined : selector === '[data-guide-channel]' ? element.dataset.guideChannel !== undefined : selector.startsWith('.') && element.className.split(/\s+/).includes(selector.slice(1));
    class Element {
      constructor(id = '') { this.id = id; this.children = []; this.listeners = {}; this.dataset = {}; this.style = {}; this.attributes = {}; this.className = ''; this.hidden = false; this.disabled = false; this.open = false; this.textContent = ''; }
      append(...children) { this.children.push(...children); }
      replaceChildren(...children) { this.children = children; }
      setAttribute(name, value) { this.attributes[name] = value; }
      querySelectorAll(selector) { return descendants(this).filter(element => matches(element, selector)); }
      contains(element) { return element === this || descendants(this).includes(element); }
      addEventListener(name, callback) { (this.listeners[name] ??= []).push(callback); }
      emit(name, extra = {}) { for (const callback of this.listeners[name] || []) callback({ target: this, preventDefault() {}, ...extra }); }
      focus() { document.activeElement = this; }
      showModal() { this.open = true; }
      close() { this.open = false; }
      getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 700 }; }
    }
    const get = id => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); };
    get('guide-conflict').append(get('guide-conflict-message'), get('guide-replace'), get('guide-keep'));
    const document = {
      activeElement: get('open-guide'), hidden: false,
      getElementById: get, createElement: () => new Element(),
      querySelectorAll: selector => selector === '[data-open-guide]' ? [get('open-guide'), get('open-guide-player')] : [],
      addEventListener(name, callback) { (documentListeners[name] ??= []).push(callback); },
    };
    class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
    const context = vm.createContext({
      document, Date: ClockDate, Intl, AbortController, console,
      navigator: supported ? { locks } : {},
      localStorage: { getItem: key => storage.get(key) ?? null, setItem(key, value) { writes.push({ key, value, locked: activeLocks > 0 }); storage.set(key, value); } },
      addEventListener(name, callback) { (windowListeners[name] ??= []).push(callback); },
      fetch: async url => {
        fetches.push(url);
        const result = typeof response === 'function' ? response() : response;
        if (result instanceof Error) throw result;
        return { ok: true, json: async () => JSON.parse(JSON.stringify(result)) };
      },
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
      setInterval(callback, interval) { const id = ++timerId; timers.set(id, { callback, at: now + interval, interval }); return id; },
      clearInterval(id) { timers.delete(id); },
    });
    context.window = context;
    vm.runInContext(modelSource, context, { filename: 'public/guide-model.js' });
    vm.runInContext(uiSource, context, { filename: 'public/guide-ui.js' });
    const controller = context.CharliflixGuide.create({ channels: [{ id: '339', name: 'Cartoon Network' }, { id: '310', name: 'Comedy Central' }], channelName: channel => channel.name, onTune: channelId => tuned.push({ channelId, locked: activeLocks > 0, remaining: queue() }) });
    await settle();
    return {
      get, document, controller, tuned, fetches,
      async open() { await controller.open(); await settle(); },
      async clickProgramme(channelId, start) {
        const button = get('guide-grid').querySelectorAll('[data-programme-key]').find(item => item.dataset.programmeKey === `${channelId}:${start}`);
        assert.ok(button, 'the programme must appear in the rendered guide');
        if (!button.disabled) { button.focus(); button.emit('click'); }
        await settle();
        return button;
      },
      async click(id) { get(id).focus(); get(id).emit('click'); await settle(); },
      async wake(ms) { now += ms; for (const callback of windowListeners.pageshow || []) callback({}); await settle(); },
      async storageChanged() { for (const callback of windowListeners.storage || []) callback({ key: STORAGE_KEY }); await settle(); },
    };
  }
  function queue() { return JSON.parse(storage.get(STORAGE_KEY) || '{"items":[]}').items; }
  async function advance(ms) {
    now += ms;
    let iterations = 0;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= now);
      if (!due.length) break;
      assert.ok(++iterations < 100, 'deadline timers cannot create a busy retry loop');
      for (const [id, timer] of due) {
        if (!timers.has(id)) continue;
        if (timer.interval) timer.at = now + timer.interval;
        else timers.delete(id);
        timer.callback();
      }
      await settle();
    }
  }
  return { player, advance, queue, writes, lockCalls, storage, jumpClock(ms) { now += ms; } };
}

test('guide scheduling requires explicit conflict replacement and a persisted deadline tune runs once under the shared lock', async () => {
  const w = world();
  const p = await w.player();
  await p.open();
  await p.clickProgramme('339', programme().start);
  assert.equal(w.queue()[0].channelId, '339');
  await p.clickProgramme('310', programme().start);
  assert.equal(p.get('guide-conflict').hidden, false);
  assert.equal(w.queue()[0].channelId, '339', 'a conflicting click cannot silently replace the scheduled show');
  await p.click('guide-replace');
  assert.equal(w.queue()[0].channelId, '310');
  await w.advance(30 * minute);
  assert.equal(p.tuned.length, 1);
  assert.equal(p.tuned[0].channelId, '310');
  assert.equal(p.tuned[0].locked, true);
  assert.deepEqual(p.tuned[0].remaining, [], 'the removal is saved before actual player tuning');
  assert.equal(p.controller.isOpen(), false);
  await w.advance(minute);
  assert.equal(p.tuned.length, 1);
  assert.ok(w.writes.every(write => write.locked));
  assert.ok(w.lockCalls.every(name => name === STORAGE_KEY));
  p.controller.destroy();
});

test('a stale second player toggles the refreshed queue and reports removal rather than an opposite scheduling action', async () => {
  const w = world();
  const first = await w.player(), second = await w.player();
  await first.open(); await second.open();
  await first.clickProgramme('339', programme().start);
  assert.equal(w.queue().length, 1);
  await second.clickProgramme('339', programme().start);
  assert.deepEqual(w.queue(), []);
  assert.equal(second.get('guide-feedback').textContent, 'Scheduled switch removed.');
  await first.storageChanged();
  assert.equal(first.get('schedule-count').textContent, '0');
  await w.advance(30 * minute);
  assert.equal(first.tuned.length + second.tuned.length, 0);
  first.controller.destroy(); second.controller.destroy();
});

test('two open guide players share one persisted deadline claim and cannot both tune the same show', async () => {
  const w = world([programme()]);
  const first = await w.player(), second = await w.player();
  await w.advance(30 * minute);
  assert.equal(first.tuned.length + second.tuned.length, 1);
  assert.deepEqual(w.queue(), []);
  assert.equal(first.get('schedule-count').textContent, '0');
  assert.equal(second.get('schedule-count').textContent, '0');
  first.controller.destroy(); second.controller.destroy();
});

test('pageshow catches a minimized or sleeping player up within grace and skips a much later wake', async () => {
  const w = world([programme()]);
  const p = await w.player();
  await p.wake(32 * minute);
  assert.equal(p.tuned.length, 1);
  assert.equal(p.tuned[0].channelId, '339');
  assert.deepEqual(w.queue(), []);
  p.controller.destroy();

  const lateWorld = world([programme()]);
  const late = await lateWorld.player();
  await late.wake(36 * minute);
  assert.equal(late.tuned.length, 0);
  assert.deepEqual(lateWorld.queue(), []);
  assert.match(late.get('guide-toast').textContent, /missed scheduled switch/);
  late.controller.destroy();
});

test('without Web Locks future scheduling is disabled while an airing programme can still be watched immediately', async () => {
  const w = world();
  const p = await w.player({ supported: false });
  await p.open();
  assert.match(p.get('schedule-help').textContent, /Web Locks/);
  const future = await p.clickProgramme('339', programme().start);
  assert.equal(future.disabled, true);
  assert.deepEqual(w.queue(), []);
  const airing = await p.clickProgramme('339', base - 15 * minute);
  assert.equal(airing.disabled, false);
  assert.equal(p.tuned.length, 1);
  assert.equal(w.lockCalls.length, 0);
  p.controller.destroy();
});

test('unavailable listings keep navigation bounded and channel-name tuning usable', async () => {
  const w = world();
  const p = await w.player({ response: new Error('Guide offline') });
  await p.open();
  assert.match(p.get('guide-message').textContent, /couldn’t be loaded/);
  assert.equal(p.get('guide-previous').disabled, true);
  assert.equal(p.get('guide-next').disabled, true);
  const before = p.get('guide-range').textContent;
  await p.click('guide-next'); await p.click('guide-previous');
  assert.equal(p.get('guide-range').textContent, before, 'guarded handlers cannot produce a NaN time window even if invoked programmatically');
  p.get('guide-grid').querySelectorAll('.guide-channel-button')[0].emit('click');
  assert.equal(p.tuned[0].channelId, '339');
  assert.deepEqual(w.queue(), []);
  p.controller.destroy();
});

test('a visible guide retries failed listings after one minute instead of waiting for the normal cache interval', async () => {
  let available = false;
  const w = world();
  const p = await w.player({ response: () => available ? listings() : new Error('Guide offline') });
  await p.open();
  assert.equal(p.fetches.length, 1);
  await w.advance(30_000);
  assert.equal(p.fetches.length, 1, 'the clock check must respect the failure backoff');
  available = true;
  await w.advance(30_000);
  assert.equal(p.fetches.length, 2);
  assert.match(p.get('guide-message').textContent, /Listings available through/);
  assert.equal(p.get('channel-now-339').textContent, 'Programme 339');
  p.controller.destroy();
});

test('the clock refresh preserves keyboard focus on the same channel button when rebuilding the guide grid', async () => {
  const w = world();
  const p = await w.player();
  await p.open();
  const original = p.get('guide-grid').querySelectorAll('[data-guide-channel]').find(button => button.dataset.guideChannel === '310');
  original.focus();
  await w.advance(30_000);
  const refreshed = p.get('guide-grid').querySelectorAll('[data-guide-channel]').find(button => button.dataset.guideChannel === '310');
  assert.notEqual(refreshed, original, 'the periodic update should actually rebuild the grid in this regression');
  assert.equal(p.document.activeElement, refreshed);
  p.controller.destroy();
});

test('conflict confirmation receives focus and Keep or Replace returns it to the corresponding programme', async () => {
  const w = world();
  const p = await w.player();
  await p.open();
  await p.clickProgramme('339', programme().start);
  await p.clickProgramme('310', programme().start);
  assert.equal(p.document.activeElement, p.get('guide-replace'));
  await p.click('guide-keep');
  assert.equal(p.get('guide-conflict').hidden, true);
  assert.equal(p.document.activeElement.dataset.programmeKey, `310:${programme().start}`);
  assert.equal(w.queue()[0].channelId, '339');
  await p.clickProgramme('310', programme().start);
  assert.equal(p.document.activeElement, p.get('guide-replace'));
  await p.click('guide-replace');
  assert.equal(p.get('guide-conflict').hidden, true);
  assert.equal(p.document.activeElement.dataset.programmeKey, `310:${programme().start}`);
  assert.equal(p.document.activeElement.attributes['aria-pressed'], 'true');
  assert.equal(w.queue()[0].channelId, '310');
  p.controller.destroy();
});

test('an expired conflict replacement explains the failure and leaves the original scheduled switch intact', async () => {
  const w = world();
  const p = await w.player();
  await p.open();
  await p.clickProgramme('339', programme().start);
  await p.clickProgramme('310', programme().start);
  // Simulate suspended callbacks while the confirmation remains open. The
  // explicit Replace action must revalidate its formerly future programme.
  w.jumpClock(31 * minute);
  await p.click('guide-replace');
  assert.equal(p.get('guide-conflict').hidden, true);
  assert.equal(p.get('guide-feedback').hidden, false);
  assert.match(p.get('guide-feedback').textContent, /can no longer be scheduled/);
  assert.equal(w.queue()[0].channelId, '339');
  assert.equal(p.tuned.length, 0);
  p.controller.destroy();
});
