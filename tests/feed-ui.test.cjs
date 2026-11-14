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
async function player(channels = [channel()], stored = {}, options = {}) {
  const nodes = new Map();
  const created = [];
  const timers = new Map();
  const storage = new Map(Object.entries(stored));
  const documentListeners = {};
  const requests = [];
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
      this.readyState = 0;
      this.seeking = false;
      this.error = null;
      this.duration = NaN;
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
    removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    querySelector() { return this.inner ??= new Element(); }
    matches() { return false; }
    contains() { return false; }
    pause() { this.paused = true; this.emit('pause'); }
    load() { this.currentTime = 0; }
    play() { this.paused = false; this.playCalls = (this.playCalls || 0) + 1; return Promise.resolve(); }
    focus() { document.activeElement = this; }
    closest() { return this.editable ? this : null; }
    getBoundingClientRect() { return { x: 180, y: 80, width: 520, height: 300 }; }
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
    addEventListener(name, callback) { (documentListeners[name] ??= []).push(callback); },
  };

  const guide = { opened: false, toggles: 0, closes: 0,
    isOpen() { return this.opened; },
    toggle() { this.opened = !this.opened; this.toggles++; },
    close() { this.opened = false; this.closes++; },
    destroy() {},
  };
  let guideOptions;

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
    document, Hls, console, URL, AbortController,
    window: { Hls, scrollY: 0, innerWidth:720, innerHeight:492, scrollTo() {}, addEventListener() {}, CharliflixHistory:options.history, CharliflixSettings:options.settings, ...(options.guide ? { CharliflixGuide: { create(value) { guideOptions = value; return guide; } }, CharliflixGuideModel: {} } : {}) },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    fetch: async (url, init = {}) => {
      requests.push({ url, ...init });
      return options.fetchImpl?.(url, init) || { ok: true, json: async () => ({ channels }) };
    },
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
    get, body, document, storage, timers, elapse, guide, requests,
    flush: () => new Promise(setImmediate),
    back: () => context.window.charliflixBack(),
    suspend: () => context.window.charliflixSuspend(),
    nativeState: () => context.window.charliflixAndroidState(),
    setPip: enabled => context.window.charliflixSetPictureInPicture(enabled),
    programmes: values => guideOptions.onCurrentProgrammes(values),
    get current() { return Hls.instances.at(-1); },
    get attempts() { return Hls.instances; },
    click: id => get(id).emit('click'),
    selectChannel: id => created.find(node => node.className === 'channel-card' && node.dataset.id === id).emit('click'),
    chooseFeed: feed => { get('feed-select').value = feed; get('feed-select').emit('change'); },
    fatal: (details = {}) => Hls.instances.at(-1).emit('error', { fatal: true, type: 'other', ...details }),
    playing() { get('video').paused = false; get('video').readyState = 3; get('video').emit('playing'); },
    key(key, extra = {}) {
      const event = { key, target: body, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
      for (const callback of documentListeners.keydown || []) callback(event);
      return event;
    },
    guideTune(id) { guideOptions.onTune(id); },
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

test('a manual Cartoon Network Player 2 choice is requested first and a fast fallback explains both attempts', async () => {
  const p = await player();
  p.chooseFeed('cast');
  assert.equal(p.current.url, '/api/channels/339/feeds/cast/playlist.m3u8');
  assert.equal(p.get('feed-select').value, 'cast');
  p.fatal({ type: 'network', details: 'manifestLoadError' });
  assert.equal(p.current.url, '/api/channels/339/feeds/stream/playlist.m3u8');
  assert.match(p.get('loading-text').textContent, /Player 2 failed; trying Player 1/);
  assert.match(p.get('playback-note').textContent, /Player 2 failed; trying Player 1/);
  p.get('video').emit('waiting');
  assert.match(p.get('loading-text').textContent, /Player 2 failed; buffering Player 1/);
  assert.match(p.get('playback-note').textContent, /Player 2 failed; waiting for Player 1/);
  p.fatal({ type: 'network', details: 'fragLoadError' });
  assert.match(p.get('playback-note').textContent, /Player 2 failed; reconnecting to Player 1/);
  p.elapse(1500);
  assert.equal(p.get('feed-select').value, 'stream', 'the selector describes the active attempt');
  assert.equal(JSON.parse(p.storage.get('channel-room:feeds'))['339'], 'cast', 'fallback never replaces the manual preference');
  p.fatal({ type: 'network', details: 'manifestLoadError' });
  assert.match(p.get('error-detail').textContent, /Player 2 → Player 1/);
  assert.equal(p.attempts.length, 2);
  p.selectChannel('339');
  assert.equal(p.current.url, '/api/channels/339/feeds/cast/playlist.m3u8', 'returning to the channel still honors the saved Player 2 choice');
});

test('fallback history follows actual requests across additional configured feeds and clears on playback', async () => {
  const p = await player([channel('339', { feeds: [
    { id: 'stream', label: 'Player 1' }, { id: 'cast', label: 'Player 2' }, { id: 'plus', label: 'Player 4' },
  ] })]);
  p.chooseFeed('cast');
  p.fatal();
  p.fatal();
  assert.equal(p.current.url, '/api/channels/339/feeds/plus/playlist.m3u8');
  assert.match(p.get('playback-note').textContent, /Player 1 failed; trying Player 4/);
  p.playing();
  assert.equal(p.get('playback-note').textContent, 'Watching live · Player 4');
  p.get('video').emit('waiting');
  assert.equal(p.get('playback-note').textContent, 'Waiting for Player 4', 'success clears the obsolete failure explanation');
  p.fatal();
  assert.match(p.get('error-detail').textContent, /Player 2 → Player 1 → Player 4/);
  assert.equal(p.attempts.length, 3);
  assert.equal(JSON.parse(p.storage.get('channel-room:feeds'))['339'], 'cast');
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

test('five enabled feeds exhaust in order within one manual and four shorter automatic startup deadlines', async () => {
  const p = await player([channel('339', { feeds: [
    { id: 'stream', label: 'Player 1' },
    { id: 'blocked', label: 'Blocked player', enabled: false, reason: 'Provider unavailable' },
    { id: 'cast', label: 'Player 2' }, { id: 'plus', label: 'Player 4' },
    { id: 'casting', label: 'Player 5' }, { id: 'kso', label: 'Player 6' },
  ] })]);
  p.chooseFeed('stream');
  p.elapse(20000);
  p.get('video').emit('waiting');
  p.elapse(14999);
  assert.equal(p.attempts.length, 1, 'the initial manual attempt retains its 35-second startup allowance');
  p.elapse(1);
  for (const [index, feed] of ['cast', 'plus', 'casting', 'kso'].entries()) {
    const attempt = p.current;
    assert.equal(attempt.url, `/api/channels/339/feeds/${feed}/playlist.m3u8`);
    p.elapse(5000); p.get('video').emit('waiting');
    p.elapse(5000); p.get('video').emit('waiting');
    p.elapse(4999); p.get('video').emit('waiting');
    assert.equal(p.current, attempt, 'automatic startup gets the complete 15-second allowance');
    p.elapse(1);
    if (index < 3) assert.equal(attempt.destroyed, true, 'waiting events cannot extend automatic startup');
  }
  assert.deepEqual(p.attempts.map(attempt => attempt.url), ['stream', 'cast', 'plus', 'casting', 'kso'].map(feed => `/api/channels/339/feeds/${feed}/playlist.m3u8`));
  assert.equal(p.get('error-overlay').hidden, false);
  assert.match(p.get('error-detail').textContent, /Player 1 → Player 2 → Player 4 → Player 5 → Player 6/);
  assert.equal(JSON.parse(p.storage.get('channel-room:feeds'))['339'], 'stream');
  assert.equal(p.timers.size, 0);
  p.elapse(120000);
  assert.equal(p.attempts.length, 5, 'exhausted feeds never restart themselves');
});

test('a new manual choice after automatic fallback restores the full manual startup allowance', async () => {
  const p = await player([channel('339', { feeds: [
    { id: 'stream', label: 'Player 1' }, { id: 'cast', label: 'Player 2' }, { id: 'plus', label: 'Player 4' },
  ] })]);
  p.click('start-watching'); p.fatal();
  assert.equal(p.get('feed-select').value, 'cast');
  p.chooseFeed('plus');
  const manual = p.current;
  p.elapse(20000); p.get('video').emit('waiting');
  p.elapse(14999);
  assert.equal(p.current, manual);
  p.elapse(1);
  assert.equal(p.current.url, '/api/channels/339/feeds/stream/playlist.m3u8');
  assert.equal(JSON.parse(p.storage.get('channel-room:feeds'))['339'], 'plus');
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

test('mute and guide shortcuts ignore editing, modifiers, repeats and already-handled keyboard events', async () => {
  const p = await player([channel()], {}, { guide: true });
  assert.equal(p.get('video').muted, false);
  assert.equal(p.key('m').defaultPrevented, true);
  assert.equal(p.get('video').muted, true);
  assert.equal(p.storage.get('channel-room:muted'), 'true');
  p.key('M');
  assert.equal(p.get('video').muted, false);
  const editor = p.get('text-editor'); editor.editable = true;
  for (const extra of [{ target: editor }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }]) {
    p.key('m', extra); p.key('g', extra);
  }
  assert.equal(p.get('video').muted, false);
  assert.equal(p.guide.toggles, 0);
  p.key('g');
  assert.equal(p.guide.isOpen(), true);
  p.key('G');
  assert.equal(p.guide.isOpen(), false);
});

test('Escape closes the guide before exiting theater mode and restores theater control focus afterward', async () => {
  const p = await player([channel()], {}, { guide: true });
  p.click('theater'); p.key('g');
  assert.equal(p.body.classList.contains('theater-mode'), true);
  assert.equal(p.key('Escape').defaultPrevented, true);
  assert.equal(p.guide.closes, 1);
  assert.equal(p.body.classList.contains('theater-mode'), true);
  p.key('Escape');
  assert.equal(p.body.classList.contains('theater-mode'), false);
  assert.equal(p.document.activeElement, p.get('theater'));
});

test('guide tuning uses configured channels while preserving audio, preferred feeds and theater mode', async () => {
  const p = await player([channel(), channel('310')], { 'channel-room:feeds': '{"310":"cast"}', 'channel-room:volume': '0.42', 'channel-room:muted': 'true' }, { guide: true });
  p.click('theater'); p.guideTune('310');
  assert.equal(p.current.url, '/api/channels/310/feeds/cast/playlist.m3u8');
  assert.equal(p.get('video').muted, true);
  assert.equal(p.get('video').volume, 0.42);
  assert.equal(p.body.classList.contains('theater-mode'), true);
  p.guideTune('not-configured');
  assert.equal(p.attempts.length, 1, 'unrecognized guide channels cannot start an arbitrary source');
});

function archiveChannel() {
  return channel('1054', { name: 'Adult Swim Archive', playbackType: 'file', defaultFeed: 'spelunkr', feeds: [{ id: 'spelunkr', label: 'Spelunkr 54' }] });
}
function archiveDescriptor(extras = {}) {
  return { type: 'file', url: 'https://archive.org/download/example-recording/block.mp4',
    startTime: 45, trimStart: 20, trimEnd: 145, serverTime: 100000, endsAt: 200000,
    programTitle: 'Example Adult Swim Block', ...extras };
}
const jsonResponse = data => ({ ok: true, json: async () => data });

test('archive playback uses the bounded descriptor and seeks to its rotation position after metadata arrives', async () => {
  const descriptor = archiveDescriptor();
  const p = await player([archiveChannel()], {}, { fetchImpl: url => url.endsWith('/playback') ? jsonResponse(descriptor) : undefined });
  p.click('start-watching');
  await p.flush();
  assert.equal(p.attempts.length, 0, 'archive files never go through the HLS resolver');
  assert.equal(p.requests.at(-1).url, '/api/channels/1054/playback');
  assert.equal(p.get('video').src, descriptor.url);
  assert.equal(p.get('video').preload, 'metadata');
  assert.equal(p.get('video').playCalls || 0, 0, 'the player waits until it can seek');
  p.elapse(2000);
  p.get('video').duration = 200;
  p.get('video').emit('loadedmetadata');
  assert.equal(p.get('video').currentTime, 47, 'metadata delay advances the offset instead of replaying old content');
  assert.equal(p.get('video').playCalls, 1);
  p.playing();
  assert.equal(p.get('state-text').textContent, 'Archive');
  assert.match(p.get('playback-note').textContent, /Example Adult Swim Block.*Charliflix rotation/);
  assert.match(p.get('go-live').title, /archive rotation/);
});

test('slow archive startup gets its own deadline and first playback starts a fresh progress window', async () => {
  const p = await player([archiveChannel()], {}, { fetchImpl: url => url.endsWith('/playback') ? jsonResponse(archiveDescriptor({ trimEnd: 1045, endsAt: 1100000 })) : undefined });
  p.click('start-watching'); await p.flush();
  p.elapse(45000);
  p.get('video').emit('waiting');
  assert.equal(p.get('error-overlay').hidden, true, 'archive loading can exceed live-feed startup limits');
  p.get('video').duration = 1200;
  p.get('video').emit('loadedmetadata'); p.playing();
  p.elapse(0);
  assert.equal(p.get('error-overlay').hidden, true, 'starting video cannot immediately time out against the tune timestamp');
  assert.equal(p.get('state-text').textContent, 'Archive');
  p.elapse(59999);
  p.get('video').emit('waiting'); p.playing();
  assert.equal(p.get('error-overlay').hidden, true);
  p.elapse(1);
  assert.equal(p.get('error-overlay').hidden, false, 'repeated events without video progress cannot extend the archive stall deadline');
});

test('an archive that starts after the finite startup timeout clears its error and remains playable', async () => {
  const p = await player([archiveChannel()], {}, { fetchImpl: url => url.endsWith('/playback') ? jsonResponse(archiveDescriptor({ trimEnd: 1045, endsAt: 1100000 })) : undefined });
  p.click('start-watching'); await p.flush();
  p.elapse(119999); p.get('video').emit('waiting');
  assert.equal(p.get('error-overlay').hidden, true);
  p.elapse(1);
  assert.equal(p.get('error-overlay').hidden, false, 'a genuinely unresponsive recording still has a finite timeout');
  p.elapse(10000);
  const video = p.get('video'); video.duration = 1200;
  video.emit('loadedmetadata');
  video.readyState = 3; video.emit('timeupdate');
  assert.equal(p.get('error-overlay').hidden, false, 'the initial seek alone is not evidence of playback');
  p.playing(); p.elapse(0);
  assert.equal(p.get('error-overlay').hidden, true);
  assert.equal(p.get('loading-overlay').hidden, true);
  assert.equal(p.get('state-text').textContent, 'Archive');
  assert.equal(p.get('go-live').disabled, false);
  p.elapse(20000); video.currentTime += 20; video.emit('timeupdate');
  p.elapse(20000);
  assert.equal(p.get('error-overlay').hidden, true);
});

test('resuming a paused archive retains its full buffering allowance', async () => {
  const p = await player([archiveChannel()], {}, { fetchImpl: url => url.endsWith('/playback') ? jsonResponse(archiveDescriptor({ trimEnd: 1045, endsAt: 1100000 })) : undefined });
  p.click('start-watching'); await p.flush();
  p.get('video').duration = 1200; p.get('video').emit('loadedmetadata'); p.playing();
  p.click('play-toggle'); p.elapse(10000); p.click('play-toggle');
  p.elapse(59999);
  assert.equal(p.get('error-overlay').hidden, true);
  p.elapse(1);
  assert.equal(p.get('error-overlay').hidden, false);
});

test('real archive progress recovers a stall without another playing event and restores block transitions', async () => {
  let calls = 0;
  const p = await player([archiveChannel()], {}, { fetchImpl: url => {
    if (!url.endsWith('/playback')) return undefined;
    calls++;
    return jsonResponse(archiveDescriptor({ trimEnd: 1045, endsAt: 300000 }));
  } });
  p.click('start-watching'); await p.flush();
  const video = p.get('video'); video.duration = 1200;
  video.emit('loadedmetadata'); p.playing();
  p.elapse(60000);
  assert.equal(p.get('error-overlay').hidden, false);
  for (const extra of [{ seeking: true }, { readyState: 1 }, { paused: true }, { error: { code: 3 } }]) {
    Object.assign(video, { seeking: false, readyState: 3, paused: false, error: null }, extra);
    video.currentTime += 0.1; video.emit('timeupdate');
    assert.equal(p.get('error-overlay').hidden, false, 'unplayable media events cannot dismiss the error');
  }
  Object.assign(video, { seeking: false, readyState: 3, paused: false, error: null });
  video.currentTime += 0.25; video.emit('timeupdate'); p.elapse(0);
  assert.equal(p.get('error-overlay').hidden, true);
  assert.equal(p.get('state-text').textContent, 'Archive');
  assert.match(p.get('playback-note').textContent, /Charliflix rotation/);
  for (let i = 0; i < 6; i++) { p.elapse(20000); video.currentTime += 20; video.emit('timeupdate'); }
  p.elapse(20000); await p.flush();
  assert.equal(calls, 2, 'recovery rearms the automatic archive block transition');
});

test('hard archive errors and native suspension cannot be dismissed by late media events', async () => {
  const p = await player([archiveChannel()], {}, { fetchImpl: url => url.endsWith('/playback') ? jsonResponse(archiveDescriptor()) : undefined });
  p.click('start-watching'); await p.flush();
  const video = p.get('video'); video.duration = 40; video.emit('loadedmetadata');
  p.playing(); video.currentTime = 30; video.emit('timeupdate');
  assert.equal(p.get('error-overlay').hidden, false);
  assert.match(p.get('error-detail').textContent, /shorter than its published schedule/);
  p.click('retry'); await p.flush();
  p.suspend(); p.playing(); video.currentTime = 46; video.emit('timeupdate');
  assert.equal(p.get('state-text').textContent, 'Connecting');
  assert.equal(p.timers.size, 0, 'late playing cannot restart watchdogs in the background');
});

test('changing channels aborts an old archive request and ignores a late response', async () => {
  let complete;
  const response = new Promise(resolve => { complete = resolve; });
  const p = await player([archiveChannel(), channel()], {}, { fetchImpl: url => url.endsWith('/playback') ? response : undefined });
  p.selectChannel('1054');
  const request = p.requests.at(-1);
  assert.equal(request.signal.aborted, false);
  p.selectChannel('339');
  assert.equal(request.signal.aborted, true);
  const live = p.current;
  assert.equal(live.url, '/api/channels/339/feeds/stream/playlist.m3u8');
  complete(jsonResponse(archiveDescriptor()));
  await p.flush();
  assert.equal(p.get('video').src, '', 'a stale descriptor cannot assign its media URL after a tune');
  assert.equal(p.current, live);
  assert.equal(p.get('now-title').textContent, 'Cartoon Network');
  assert.equal(p.get('error-overlay').hidden, true);
});

test('archive playback advances at the wall-clock deadline even with remaining video and refreshes at trimEnd', async () => {
  for (const trigger of ['deadline', 'trim']) {
    let calls = 0;
    const p = await player([archiveChannel()], {}, { fetchImpl: url => {
      if (!url.endsWith('/playback')) return undefined;
      return jsonResponse(archiveDescriptor({ serverTime: calls ? 102000 : 100000, endsAt: calls++ ? 202000 : 102000 }));
    } });
    p.click('start-watching'); await p.flush();
    p.get('video').emit('loadedmetadata'); p.playing();
    if (trigger === 'deadline') {
      p.elapse(1999);
      assert.equal(calls, 1);
      p.elapse(1);
    } else {
      p.get('video').currentTime = 144.9;
      p.get('video').emit('timeupdate');
      assert.equal(calls, 1);
      p.get('video').currentTime = 145;
      p.get('video').emit('timeupdate');
    }
    await p.flush();
    assert.equal(calls, 2, `${trigger} gets a fresh current programme instead of playing beyond the trim`);
    assert.equal(p.get('video').paused, true, 'the next programme seeks before playing');
    assert.equal(p.get('error-overlay').hidden, true);
    assert.equal(p.attempts.length, 0);
  }
});

test('pausing beyond an archive deadline waits for play then fetches the current rotation', async () => {
  let calls = 0;
  const p = await player([archiveChannel()], {}, { fetchImpl: url => {
    if (!url.endsWith('/playback')) return undefined;
    return jsonResponse(archiveDescriptor(calls++ ? { serverTime: 150000, endsAt: 250000, startTime: 90 } : { endsAt: 102000 }));
  } });
  p.click('start-watching'); await p.flush();
  p.get('video').emit('loadedmetadata'); p.playing();
  p.click('play-toggle');
  p.elapse(50000); await p.flush();
  assert.equal(calls, 1, 'paused playback never retunes in the background');
  assert.equal(p.get('state-text').textContent, 'Paused');
  p.click('play-toggle'); await p.flush();
  assert.equal(calls, 2, 'resume does not replay an expired programme');
  p.get('video').emit('loadedmetadata');
  assert.equal(p.get('video').currentTime, 90);
  assert.equal(p.get('video').playCalls, 2);
});

test('invalid archive descriptors fail without assigning an arbitrary media source or starting HLS', async () => {
  for (const extras of [
    { url: 'https://elsewhere.example/download/block.mp4' },
    { url: 'http://archive.org/download/block.mp4' },
    { url: 'https://user:pass@archive.org/download/block.mp4' },
    { url: 'https://archive.org:8443/download/block.mp4' },
    { url: 'https://archive.org/download/block.mp4?token=unknown' },
    { url: 'https://archive.org/download/block.mp4#fragment' },
    { url: 'https://archive.org/arbitrary/block.mp4' },
    { url: 'https://archive.org/download/playlist.m3u8' },
    { type: 'other' }, { startTime: 19 }, { startTime: 145 }, { trimStart: -1 },
    { trimEnd: 172801 }, { serverTime: null }, { endsAt: 100000 },
  ]) {
    const p = await player([archiveChannel()], {}, { fetchImpl: url => url.endsWith('/playback') ? jsonResponse(archiveDescriptor(extras)) : undefined });
    p.click('start-watching'); await p.flush();
    assert.equal(p.get('video').src, '', JSON.stringify(extras));
    assert.equal(p.get('error-overlay').hidden, false);
    assert.match(p.get('error-detail').textContent, /archive recording could not be loaded/);
    assert.equal(p.attempts.length, 0);
    assert.equal(p.timers.size, 0, 'an invalid descriptor cannot start an unbounded retry loop');
  }
});

test('archive metadata rejects recordings shorter than the rotation position', async () => {
  const p = await player([archiveChannel()], {}, { fetchImpl: url => url.endsWith('/playback') ? jsonResponse(archiveDescriptor()) : undefined });
  p.click('start-watching'); await p.flush();
  p.get('video').duration = 40;
  p.get('video').emit('loadedmetadata');
  assert.equal(p.get('error-overlay').hidden, false);
  assert.match(p.get('error-detail').textContent, /shorter than its published schedule/);
  assert.equal(p.get('video').playCalls || 0, 0);
});

test('native Android Back closes the guide then theater before returning control to the shell', async () => {
  const p = await player([channel()], {}, { guide: true });
  assert.equal(p.back(), false);
  p.click('theater'); p.key('g');
  assert.equal(p.back(), true);
  assert.equal(p.guide.closes, 1);
  assert.equal(p.body.classList.contains('theater-mode'), true);
  assert.equal(p.back(), true);
  assert.equal(p.body.classList.contains('theater-mode'), false);
  assert.equal(p.back(), false);
});

test('native suspension prevents a pending HLS manifest from autoplaying until explicit Play resumes loading', async () => {
  const p = await player();
  p.click('start-watching');
  const live = p.current;
  p.suspend();
  assert.equal(live.stopped, true);
  assert.equal(p.get('video').paused, true);
  live.emit('manifest');
  await p.flush();
  assert.equal(p.get('video').playCalls || 0, 0, 'a late manifest cannot restart sound or playback in the background');
  assert.equal(live.restarts || 0, 0);
  assert.equal(p.timers.size, 0, 'suspension cancels the playback deadline');
  p.click('play-toggle');
  assert.equal(p.get('video').playCalls, 1);
  assert.equal(live.restarts, 1, 'explicit Play restarts the stopped HLS loader');
  assert.equal(p.get('video').paused, false);
});

test('native suspension prevents a late archive descriptor and metadata from autoplaying until explicit Play', async () => {
  let complete;
  const response = new Promise(resolve => { complete = resolve; });
  const p = await player([archiveChannel()], {}, { fetchImpl: url => url.endsWith('/playback') ? response : undefined });
  p.click('start-watching');
  p.suspend();
  complete(jsonResponse(archiveDescriptor()));
  await p.flush();
  p.get('video').duration = 200;
  p.get('video').emit('loadedmetadata');
  await p.flush();
  assert.equal(p.get('video').currentTime, 45, 'the descriptor can prepare the correct offset');
  assert.equal(p.get('video').playCalls || 0, 0, 'the metadata callback cannot override native suspension');
  assert.equal(p.get('video').paused, true);
  assert.equal(p.timers.size, 0);
  p.click('play-toggle');
  assert.equal(p.get('video').playCalls, 1);
  assert.equal(p.get('video').paused, false);
  assert.equal(p.attempts.length, 0);
});

test('watched tracking counts only advancing playback and excludes pauses, seeks, missing episode data and old channel samples', async () => {
  const records = []; let flushes = 0;
  const p = await player([channel(), channel('310')], {}, { guide: true, history: { recordCoverage: (...args) => records.push(args), flush: () => flushes++ } });
  const programme = { title:'Show', subtitle:'Episode', channelId:'339', start:100000, end:200000 };
  p.programmes({ '339': programme }); p.click('start-watching'); p.playing();
  const video = p.get('video');
  video.emit('timeupdate'); p.elapse(2000); video.currentTime = 2; video.emit('timeupdate');
  assert.deepEqual(records.map(record => record.slice(1)), [[100000,102000]]);
  p.elapse(2000); video.currentTime = 100; video.emit('timeupdate');
  assert.equal(records.length, 1, 'a large media seek earns no watched time');
  video.pause(); p.elapse(10000); video.emit('timeupdate');
  assert.equal(records.length, 1);
  p.click('play-toggle'); p.playing(); video.emit('timeupdate');
  p.elapse(1000); video.currentTime += 1; video.emit('timeupdate');
  assert.equal(records.length, 2);
  p.selectChannel('310'); p.playing(); p.elapse(1000); video.currentTime = 1; video.emit('timeupdate');
  assert.equal(records.length, 2, 'another channel cannot credit the previous episode');
  p.suspend(); p.elapse(1000); video.currentTime += 1; video.emit('timeupdate');
  assert.equal(records.length, 2);
  assert.ok(flushes > 0, 'pause and native suspension flush partial history');
});

test('native PiP hooks report eligibility, keep theater preference independent and respect settings and Back order', async () => {
  let open = false, enabled = true;
  const settings = { isOpen:()=>open, close:()=>{open=false;}, isPictureInPictureEnabled:()=>enabled };
  const p = await player([channel()], {}, { guide: true, settings });
  const video = p.get('video'); video.videoWidth = 640; video.videoHeight = 480;
  assert.equal(p.nativeState().playing, false);
  p.click('start-watching'); p.playing();
  assert.equal(p.nativeState().playing, true);
  assert.equal(p.nativeState().videoWidth, 640);
  enabled=false; assert.equal(p.nativeState().pictureInPictureEnabled, false);
  open=true; p.key('g'); assert.equal(p.guide.isOpen(), false, 'settings captures other modal shortcuts');
  assert.equal(p.back(), true); assert.equal(open,false);
  p.click('theater'); p.key('g'); open=true; p.setPip(true);
  assert.equal(open,false); assert.equal(p.guide.isOpen(), false);
  assert.equal(p.body.classList.contains('picture-in-picture'), true);
  p.setPip(false);
  assert.equal(p.body.classList.contains('picture-in-picture'), false);
  assert.equal(p.body.classList.contains('theater-mode'), true, 'PiP never overwrites the saved theater setting');
  assert.equal(p.storage.get('channel-room:theater'), 'true');
  video.pause(); assert.equal(p.nativeState().playing, false);
});
