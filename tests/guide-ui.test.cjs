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
const programmeButton = (player, channelId = '339', start = programme().start) => player.get('guide-grid').querySelectorAll('[data-programme-key]').find(button => button.dataset.programmeKey === `${channelId}:${start}`);

function historyFixture() {
  const seen = new Set(), listeners = new Set();
  return {
    canTrack: item => Boolean(item?.subtitle || item?.episode),
    isWatched: item => seen.has(item?.episode || item?.subtitle),
    setWatched(item, value) { const key = item.episode || item.subtitle; if (value) seen.add(key); else seen.delete(key); for (const listener of listeners) listener(); return { ok: true }; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    listeners,
  };
}

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

  async function player({ supported = true, response = listings(), history, channels = [{ id: '339', name: 'Cartoon Network' }, { id: '310', name: 'Comedy Central' }] } = {}) {
    const nodes = new Map(), windowListeners = {}, documentListeners = {}, tuned = [], fetches = [];
    const currentProgrammes = [];
    const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
    const matches = (element, selector) => selector === '[data-programme-key]' ? element.dataset.programmeKey !== undefined : selector === '[data-guide-channel]' ? element.dataset.guideChannel !== undefined : selector.startsWith('.') && element.className.split(/\s+/).includes(selector.slice(1));
    class Element {
      constructor(id = '') { this.id = id; this.children = []; this.listeners = {}; this.dataset = {}; this.style = {}; this.attributes = {}; this.className = ''; this.hidden = false; this.disabled = false; this.open = false; this.textContent = ''; }
      get id() { return this._id; }
      set id(value) { this._id = value; if (value) nodes.set(value, this); }
      append(...children) { this.children.push(...children); }
      replaceChildren(...children) { this.children = children; }
      setAttribute(name, value) { this.attributes[name] = value; }
      querySelectorAll(selector) { return descendants(this).filter(element => matches(element, selector)); }
      contains(element) { return element === this || descendants(this).includes(element); }
      addEventListener(name, callback) { (this.listeners[name] ??= []).push(callback); }
      emit(name, extra = {}) { const event = { target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...extra }; for (const callback of this.listeners[name] || []) callback(event); return event; }
      focus() { document.activeElement = this; }
      showModal() { this.open = true; }
      close() { this.open = false; }
      getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 700 }; }
    }
    const get = id => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); };
    get('guide-conflict').append(get('guide-conflict-message'), get('guide-replace'), get('guide-keep'));
    const document = {
      body: get('body'), activeElement: get('open-guide'), hidden: false,
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
    const controller = context.CharliflixGuide.create({ channels, history, channelName: channel => channel.name, onCurrentProgrammes: value => currentProgrammes.push(value), onTune: channelId => tuned.push({ channelId, locked: activeLocks > 0, remaining: queue() }) });
    await settle();
    return {
      get, document, controller, tuned, fetches, currentProgrammes,
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

test('episode names appear below show titles and current programme metadata reaches playback tracking', async () => {
  const response = listings();
  Object.assign(response.channels[0].programmes[0], { subtitle: 'The familiar episode', episode: 'S02E03' });
  const history = historyFixture(); history.setWatched(response.channels[0].programmes[0], true);
  const w = world(), p = await w.player({ response, history });
  await p.open();
  assert.equal(p.get('channel-now-339').textContent, 'Programme 339');
  assert.equal(p.get('channel-episode-339').textContent, 'The familiar episode · S02E03');
  assert.equal(p.get('channel-watched-339').hidden, false);
  assert.equal(p.get('channel-episode-310').hidden, true, 'unknown episode names are not fabricated');
  const airing = programmeButton(p, '339', base - 15 * minute);
  assert.equal(airing.querySelectorAll('.guide-programme-episode')[0].textContent, 'The familiar episode · S02E03');
  assert.equal(airing.querySelectorAll('.watched-badge')[0].textContent, '✓ Watched');
  assert.equal(p.currentProgrammes.at(-1)['339'].episode, 'S02E03');
  assert.equal(p.currentProgrammes.at(-1)['310'].title, 'Programme 310');
  p.controller.destroy();
  assert.equal(history.listeners.size, 0);
});

test('long pressing an episode opens its description and release-click never schedules or tunes', async () => {
  const response = listings();
  Object.assign(response.channels[0].programmes[1], { subtitle: 'A future episode', episode: 'S01E02', description: '<b>Plain description text</b>' });
  const w = world(), p = await w.player({ response, history: historyFixture() });
  await p.open();
  const button = programmeButton(p);
  button.emit('pointerdown', { isPrimary: true, button: 0, clientX: 30, clientY: 30 });
  await w.advance(599);
  assert.equal(p.get('episode-dialog').open, false);
  await w.advance(1);
  assert.equal(p.get('episode-dialog').open, true);
  assert.equal(p.get('episode-description').textContent, '<b>Plain description text</b>', 'descriptions are assigned as text rather than evaluated HTML');
  assert.equal(p.get('episode-subtitle').textContent, 'A future episode · S01E02');
  await w.advance(3000);
  button.emit('pointerup');
  const click = button.emit('click');
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(w.queue(), []);
  assert.deepEqual(p.tuned, []);
  assert.equal(p.controller.isOpen(), true);
  p.controller.close();
  assert.equal(p.get('episode-dialog').open, false);
  assert.equal(p.get('guide-dialog').open, true, 'Back closes episode details before the guide');
  p.controller.close();
  assert.equal(p.get('guide-dialog').open, false);
  p.controller.destroy();
});

test('scrolling or dragging cancels long press while a short tap preserves scheduling', async () => {
  const w = world(), p = await w.player();
  await p.open();
  let button = programmeButton(p);
  button.emit('pointerdown', { clientX: 20, clientY: 20 });
  button.emit('pointermove', { clientX: 20, clientY: 45 });
  await w.advance(700);
  assert.equal(p.get('episode-dialog').open, false);
  button.emit('pointerdown', { clientX: 20, clientY: 20 });
  p.get('guide-scroll').emit('scroll');
  await w.advance(700);
  assert.equal(p.get('episode-dialog').open, false);
  button.emit('pointerdown', { clientX: 20, clientY: 20 }); button.emit('pointerup'); button.emit('click');
  await w.advance(0);
  assert.equal(w.queue().length, 1);
  p.controller.destroy();
});

test('keyboard and context-menu details allow watched toggles without changing the channel or schedule', async () => {
  const response = listings(); Object.assign(response.channels[0].programmes[1], { subtitle: 'Episode name', episode: 'S01E05' });
  const history = historyFixture(), w = world(), p = await w.player({ response, history });
  await p.open();
  programmeButton(p).emit('keydown', { key: 'i' });
  assert.equal(p.get('episode-dialog').open, true);
  assert.match(p.get('episode-description').textContent, /No description/);
  await p.click('episode-watched');
  assert.equal(history.isWatched(response.channels[0].programmes[1]), true);
  assert.match(p.get('episode-watched').textContent, /Mark unwatched/);
  assert.equal(programmeButton(p).querySelectorAll('.watched-badge').length, 1);
  await p.click('episode-watched');
  assert.equal(history.isWatched(response.channels[0].programmes[1]), false);
  assert.equal(programmeButton(p).querySelectorAll('.watched-badge').length, 0);
  await p.click('close-episode');
  assert.equal(p.document.activeElement, programmeButton(p), 'closing details restores focus after a badge rerender');
  programmeButton(p).emit('contextmenu');
  assert.equal(p.get('episode-dialog').open, true);
  assert.deepEqual(w.queue(), []); assert.deepEqual(p.tuned, []);
  p.controller.destroy();
});

test('details distinguish unidentified archive blocks and report watched-storage failure', async () => {
  const history = historyFixture(), w = world(), p = await w.player({ history });
  await p.open(); programmeButton(p).emit('keydown', { key: 'F10', shiftKey: true });
  assert.equal(p.get('episode-watched').hidden, true, 'an unknown episode cannot be manually mislabeled watched');
  p.controller.destroy();
  const response = listings(); response.channels[0].programmes[1].subtitle = 'Identified episode';
  const failed = await w.player({ response, history: { ...history, setWatched: () => ({ ok: false, code: 'storage' }) } });
  await failed.open(); programmeButton(failed).emit('contextmenu'); await failed.click('episode-watched');
  assert.match(failed.get('episode-feedback').textContent, /could not be saved/);
  assert.equal(failed.get('episode-watched').attributes['aria-pressed'], 'false');
  failed.controller.destroy();
});

test('archive guide labels use their own rotation note while airing and future blocks retain ordinary tuning and scheduling', async () => {
  const w = world();
  const note = 'Charliflix uses its own rotation; timing differs from Spelunkr.';
  const response = { status: 'ready', partial: true, from: base - minute, until: base + 60 * minute,
    channels: [{ id: '1054', status: 'ready', scheduleNote: note, programmes: [programme('1054', base - 15 * minute), programme('1054')] }] };
  const p = await w.player({ response, channels: [{ id: '1054', name: 'Adult Swim Archive' }] });
  await p.open();
  assert.match(p.get('channel-now-1054').title, /own rotation/);
  assert.doesNotMatch(p.get('channel-now-1054').title, /Eastern/);
  assert.equal(p.get('guide-grid').querySelectorAll('.guide-channel-note')[0].textContent, 'Archive rotation');
  assert.match(p.get('guide-message').textContent, /Some channel listings are unavailable/);
  const future = await p.clickProgramme('1054', programme('1054').start);
  assert.match(future.title, /timing differs/);
  assert.equal(w.queue()[0].channelId, '1054');
  await p.clickProgramme('1054', base - 15 * minute);
  assert.equal(p.tuned[0].channelId, '1054');
  await w.advance(minute);
  assert.equal(p.fetches.length, 2, 'a partial success still retries the failed guide source after one minute');
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

test('without Web Locks future scheduling stays unavailable while episode details and airing-programme tuning remain usable', async () => {
  const w = world();
  const p = await w.player({ supported: false });
  await p.open();
  assert.match(p.get('schedule-help').textContent, /Web Locks/);
  const future = await p.clickProgramme('339', programme().start);
  assert.equal(future.disabled, false, 'episode details still need an accessible interactive target');
  assert.match(p.get('guide-feedback').textContent, /Scheduling is unavailable/);
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
