'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function channel(id = '339', extras = {}) {
  return {
    id, name: id === '339' ? 'Cartoon Network' : 'Comedy Central', defaultFeed: 'stream',
    feeds: [
      { id: 'stream', label: 'Player 1' },
      { id: 'blocked', label: 'Blocked player', enabled: false, reason: 'Provider unavailable' },
      { id: 'cast', label: 'Player 2' },
    ],
    ...extras,
  };
}

// Run the real script with a small DOM/media adapter. Observe requested URLs,
// visible controls, storage, and playback actions without exposing app state.
async function player(channels = [channel()], stored = {}) {
  const nodes = new Map();
  const created = [];
  const timers = new Map();
  const storage = new Map(Object.entries(stored));
  let timerId = 0;
  let clock = 100000;

  class Element {
    constructor(id = '') {
      this.id = id;
      this.listeners = {};
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.hidden = id === 'error-overlay' || id === 'loading-overlay';
      this.paused = true;
      this.currentTime = 0;
      this.className = '';
      const classes = new Set();
      this.classList = {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        contains: name => classes.has(name),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      };
    }
    addEventListener(event, callback) { (this.listeners[event] ??= []).push(callback); }
    emit(event, data = {}) { for (const callback of this.listeners[event] || []) callback({ target: this, ...data }); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    querySelector() { return this.inner ??= new Element(); }
    matches() { return false; }
    contains() { return false; }
    pause() { this.paused = true; this.emit('pause'); }
    load() { this.currentTime = 0; }
    play() { this.paused = false; this.playCalls = (this.playCalls || 0) + 1; return Promise.resolve(); }
    focus() {}
  }

  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new Element(id));
    return nodes.get(id);
  };
  const controls = get('controls');
  const body = get('body');
  const document = {
    body, activeElement: null, getElementById: get,
    createElement() { const node = new Element(); created.push(node); return node; },
    createTextNode: text => ({ textContent: text }),
    querySelector: selector => selector === '.player-controls' ? controls : get(selector),
    querySelectorAll: () => created.filter(node => node.className === 'channel-card'),
    addEventListener() {},
  };

  class Hls {
    static instances = [];
    static Events = { MEDIA_ATTACHED: 'attached', MANIFEST_PARSED: 'manifest', LEVEL_SWITCHED: 'level', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
    static isSupported() { return true; }
    constructor() { this.events = {}; this.levels = []; this.currentLevel = -1; Hls.instances.push(this); }
    on(event, callback) { this.events[event] = callback; }
    emit(event, data = {}) { this.events[event]?.(event, data); }
    attachMedia() { this.emit('attached'); }
    loadSource(url) { this.url = url; }
    destroy() { this.destroyed = true; }
    startLoad() { this.restarts = (this.restarts || 0) + 1; }
    stopLoad() { this.stopped = true; }
    recoverMediaError() { this.recoveries = (this.recoveries || 0) + 1; }
  }

  const context = {
    document, Hls, console,
    window: { Hls, scrollY: 0, scrollTo() {}, addEventListener() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    fetch: async () => ({ ok: true, json: async () => ({ channels }) }),
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, deadline: clock + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    Date: { now: () => clock },
  };
  vm.runInNewContext(source, context, { filename: 'public/app.js' });
  await new Promise(setImmediate);

  function elapse(ms) {
    const target = clock + ms;
    let callbacks = 0;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.deadline <= target).sort((a, b) => a[1].deadline - b[1].deadline)[0];
      if (!next) break;
      assert.ok(++callbacks < 100, 'timer callbacks must not form an unbounded retry loop');
      const [id, timer] = next;
      timers.delete(id);
      clock = timer.deadline;
      timer.callback();
    }
    clock = target;
  }

  return {
    get, body, storage, timers, elapse,
    get current() { return Hls.instances.at(-1); },
    get attempts() { return Hls.instances; },
    click: id => get(id).emit('click'),
    selectChannel: id => created.find(node => node.className === 'channel-card' && node.dataset.id === id).emit('click'),
    chooseFeed: feed => { get('feed-select').value = feed; get('feed-select').emit('change'); },
    fatal: (details = {}) => Hls.instances.at(-1).emit('error', { fatal: true, type: 'other', ...details }),
    playing() { get('video').paused = false; get('video').emit('playing'); },
  };
}

test('manual feed preferences remain independent per channel and preserve audio and theater', async () => {
  const p = await player([channel(), channel('310')], {
    'channel-room:feeds': '{"339":"cast","310":"stream"}',
    'channel-room:volume': '0.42',
    'channel-room:muted': 'true',
  });
  assert.equal(p.get('feed-select').value, 'cast');
  p.click('start-watching');
  assert.equal(p.current.url, '/api/channels/339/feeds/cast/playlist.m3u8');
  p.click('theater');
  p.chooseFeed('stream');
  assert.equal(p.get('video').volume, 0.42);
  assert.equal(p.get('video').muted, true);
  assert.equal(p.body.classList.contains('theater-mode'), true);
  p.selectChannel('310');
  p.chooseFeed('cast');
  p.selectChannel('339');
  assert.equal(p.current.url, '/api/channels/339/feeds/stream/playlist.m3u8');
  p.selectChannel('310');
  assert.equal(p.current.url, '/api/channels/310/feeds/cast/playlist.m3u8');
  assert.deepEqual(JSON.parse(p.storage.get('channel-room:feeds')), { '339': 'stream', '310': 'cast' });
  assert.equal(p.storage.get('channel-room:theater'), 'true');
});

test('fatal failures try each enabled feed once without overwriting the manual preference', async () => {
  const p = await player();
  p.chooseFeed('stream');
  assert.equal(p.get('feed-select').children[1].disabled, true);
  assert.match(p.get('feed-select').children[1].textContent, /unavailable/);
  const attempts = p.attempts.length;
  p.chooseFeed('blocked');
  assert.equal(p.attempts.length, attempts, 'a disabled option cannot start playback');
  p.fatal({ type: 'network', details: 'manifestLoadError' });
  assert.equal(p.current.url, '/api/channels/339/feeds/cast/playlist.m3u8');
  assert.equal(p.get('feed-select').value, 'cast');
  assert.equal(JSON.parse(p.storage.get('channel-room:feeds'))['339'], 'stream');
  p.fatal();
  assert.equal(p.get('error-overlay').hidden, false);
  assert.equal(p.get('loading-overlay').hidden, true);
  assert.match(p.get('error-detail').textContent, /available feeds have been tried/);
  assert.equal(p.timers.size, 0);
  p.fatal();
  p.elapse(120000);
  assert.equal(p.attempts.length, 2, 'terminal errors do not restart exhausted feeds');
  p.click('retry');
  assert.equal(p.current.url, '/api/channels/339/feeds/cast/playlist.m3u8', 'retry targets the displayed feed');
  p.click('next-feed');
  assert.equal(p.current.url, '/api/channels/339/feeds/stream/playlist.m3u8');
});

test('network retries and media recovery are bounded before advancing feeds', async () => {
  const p = await player();
  p.click('start-watching');
  const primary = p.current;
  p.fatal({ type: 'network', details: 'fragLoadError' });
  p.elapse(1500);
  p.fatal({ type: 'network', details: 'fragLoadError' });
  p.elapse(3000);
  assert.equal(primary.restarts, 2);
  assert.equal(p.attempts.length, 1);
  p.fatal({ type: 'network', details: 'fragLoadError' });
  const alternate = p.current;
  assert.equal(p.attempts.length, 2);
  assert.equal(primary.destroyed, true);
  p.fatal({ type: 'media' });
  assert.equal(alternate.recoveries, 1);
  p.fatal({ type: 'media' });
  assert.equal(p.get('error-overlay').hidden, false);
  p.elapse(120000);
  assert.equal(p.attempts.length, 2);
});

test('events and queued retry callbacks from a previous channel cannot interrupt the new channel', async () => {
  const p = await player([channel(), channel('310')]);
  p.click('start-watching');
  const old = p.current;
  p.fatal({ type: 'network', details: 'fragLoadError' });
  const oldCallbacks = [...p.timers.values()].map(timer => timer.callback);
  p.selectChannel('310');
  const current = p.current;
  const plays = p.get('video').playCalls || 0;
  old.emit('error', { fatal: true, type: 'network', details: 'manifestLoadError' });
  old.emit('manifest');
  for (const callback of oldCallbacks) callback();
  assert.equal(p.current, current);
  assert.equal(p.attempts.length, 2);
  assert.equal(p.get('video').playCalls || 0, plays);
  assert.equal(old.restarts || 0, 0);
  assert.equal(p.get('now-title').textContent, 'Comedy Central');
  assert.equal(p.get('feed-select').value, 'stream');
  assert.equal(p.get('error-overlay').hidden, true);
});

test('startup and repeated buffering have a finite deadline and exhausted feeds stay stopped', async () => {
  const p = await player();
  p.click('start-watching');
  p.elapse(35000);
  assert.equal(p.current.url, '/api/channels/339/feeds/cast/playlist.m3u8');
  p.playing();
  p.elapse(20000);
  p.get('video').emit('waiting');
  p.elapse(4999);
  assert.equal(p.get('error-overlay').hidden, true);
  p.get('video').emit('waiting');
  p.elapse(1);
  assert.equal(p.get('error-overlay').hidden, false, 'buffering events cannot extend the last progress deadline');
  p.elapse(120000);
  assert.equal(p.attempts.length, 2);
});

test('real playback progress refreshes the deadline while a user pause never triggers failover', async () => {
  const p = await player();
  p.click('start-watching');
  p.playing();
  p.elapse(20000);
  p.get('video').currentTime = 4;
  p.get('video').emit('timeupdate');
  p.elapse(20000);
  assert.equal(p.attempts.length, 1);
  p.get('video').pause();
  p.elapse(120000);
  assert.equal(p.attempts.length, 1);
  assert.equal(p.get('state-text').textContent, 'Paused');
  p.click('play-toggle');
  p.playing();
  p.elapse(20000);
  assert.equal(p.attempts.length, 1, 'resuming after a long pause gets a fresh progress deadline');
});

test('disabled or removed stored preferences fall back safely and a legacy channel keeps its old route', async () => {
  for (const preference of ['blocked', 'removed']) {
    const p = await player([channel()], { 'channel-room:feeds': JSON.stringify({ '339': preference }) });
    assert.equal(p.get('feed-select').value, 'stream');
    p.click('start-watching');
    assert.equal(p.current.url, '/api/channels/339/feeds/stream/playlist.m3u8');
  }
  const legacy = await player([{ id: '339', name: 'Cartoon Network' }]);
  assert.equal(legacy.get('feed-select').disabled, true);
  legacy.click('start-watching');
  assert.equal(legacy.current.url, '/api/channels/339/playlist.m3u8');
});

test('a channel with no enabled feeds shows an error without making a request or scheduling retries', async () => {
  const p = await player([channel('339', { feeds: [{ id: 'blocked', label: 'Blocked', enabled: false }] })]);
  p.click('start-watching');
  assert.equal(p.attempts.length, 0);
  assert.equal(p.timers.size, 0);
  assert.equal(p.get('error-overlay').hidden, false);
  assert.match(p.get('error-detail').textContent, /No playable feeds/);
  assert.equal(p.get('next-feed').hidden, true);
});
