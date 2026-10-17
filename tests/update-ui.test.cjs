'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

async function interfaceWith(updateResult) {
  const nodes = new Map();
  const requests = [];
  class Element {
    constructor() { this.listeners = {}; this.dataset = {}; this.children = []; this.paused = true; this.hidden = true; this.currentTime = 0; this.classList = { add() {}, remove() {}, toggle() {} }; }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    async emit(type) { await Promise.all((this.listeners[type] || []).map(listener => listener({ target: this }))); }
    setAttribute() {}
    removeAttribute() {}
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    querySelector() { return this.inner ??= new Element(); }
    matches() { return false; }
    contains() { return false; }
    pause() { this.paused = true; this.pauses = (this.pauses || 0) + 1; }
    load() { this.loads = (this.loads || 0) + 1; }
    play() { this.paused = false; return Promise.resolve(); }
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  class Hls {
    static Events = { MEDIA_ATTACHED: 'attached', MANIFEST_PARSED: 'manifest', LEVEL_SWITCHED: 'level', ERROR: 'error' };
    static isSupported() { return true; }
    constructor() { this.listeners = {}; this.levels = []; Hls.current = this; }
    on(type, listener) { this.listeners[type] = listener; }
    attachMedia() { this.listeners.attached(); }
    loadSource(value) { this.source = value; }
    destroy() { this.destroyed = true; }
  }
  const body = get('body');
  const document = { body, getElementById: get, querySelector: get, querySelectorAll: () => [], createElement: () => new Element(), createTextNode: text => ({ textContent: text }), addEventListener() {} };
  vm.runInNewContext(source, {
    document, Hls, window: { Hls, scrollY: 0, addEventListener() {}, scrollTo() {} },
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout() { return 1; }, clearTimeout() {}, console,
    fetch: async url => {
      requests.push(url);
      if (url === '/api/version') return { ok: true, json: async () => ({ version: '0.2.0' }) };
      if (url === '/api/channels') return { ok: true, json: async () => ({ channels: [{ id: '339', name: 'Cartoon Network' }] }) };
      assert.equal(url, '/api/updates');
      if (updateResult instanceof Error) throw updateResult;
      return { ok: true, json: async () => updateResult };
    },
  }, { filename: 'public/app.js' });
  await new Promise(setImmediate);
  return { get, requests, hls: () => Hls.current, click: id => get(id).emit('click') };
}

test('updates are checked only on click and opening a validated release does not interrupt playback', async () => {
  const url = 'https://github.com/charlesmbeckwith/charliflix/releases/tag/v0.3.0';
  const ui = await interfaceWith({ status: 'available', latestVersion: '0.3.0', releaseUrl: url });
  assert.deepEqual(ui.requests, ['/api/version', '/api/channels']);
  assert.equal(ui.get('app-version').textContent, 'v0.2.0');
  await ui.click('start-watching');
  const hls = ui.hls();
  const video = ui.get('video');
  await video.play();
  await video.emit('playing');
  video.currentTime = 42;
  const pauses = video.pauses;
  const loads = video.loads;
  await ui.click('check-updates');
  assert.deepEqual(ui.requests, ['/api/version', '/api/channels', '/api/updates']);
  assert.match(ui.get('update-message').textContent, /Version 0.3.0 is available/);
  assert.equal(ui.get('open-release').hidden, false);
  assert.equal(ui.get('open-release').href, url);
  assert.equal(ui.get('check-updates').disabled, false);
  assert.equal(video.paused, false);
  assert.equal(video.currentTime, 42);
  assert.equal(video.pauses, pauses);
  assert.equal(video.loads, loads);
  assert.equal(hls.destroyed, undefined);
});

test('update results remain recoverable and untrusted release URLs are never offered', async () => {
  for (const [result, message] of [
    [{ status: 'current' }, /latest release/],
    [{ status: 'no-release' }, /no published releases/],
    [{ status: 'unavailable', reason: 'rate-limit' }, /limit was reached/],
    [new Error('Network unavailable'), /Couldn’t check/],
    [{ status: 'available', latestVersion: '0.3.0', releaseUrl: 'https://attacker.example/download' }, /Couldn’t check/],
    [{ status: 'available', latestVersion: '0.3.0', releaseUrl: 'https://github.com/charlesmbeckwith/charliflix/releases/tag/v0.3.0?next=https://attacker.example' }, /Couldn’t check/],
  ]) {
    const ui = await interfaceWith(result);
    await ui.click('check-updates');
    assert.match(ui.get('update-message').textContent, message);
    assert.equal(ui.get('open-release').hidden, true);
    assert.equal(ui.get('check-updates').disabled, false);
  }
});
