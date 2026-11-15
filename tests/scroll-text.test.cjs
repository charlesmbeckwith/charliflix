'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/scroll-text.js'), 'utf8');

function labels(...titles) {
  const queue = [], handlers = {}, observers = [], roots = [];
  let mutation = null, observedSelector;
  function changed() { if (mutation?.active) mutation.callback([]); }
  class Text {
    constructor(value) { this.value = value; this.parentNode = null; }
    get textContent() { return this.value; }
    set textContent(value) { this.value = value; changed(); }
  }
  class Element {
    constructor() {
      this.nodes = []; this.parentNode = null; this.root = false;
      this.attributes = {}; this.title = ''; this.clientWidth = 90;
      this.style = { values: {}, setProperty(name, value) { this.values[name] = value; } };
      this.className = '';
      this.classList = {
        contains: name => this.className.split(' ').includes(name),
        add: name => { if (!this.classList.contains(name)) this.className += ` ${name}`; },
        toggle: (name, enabled) => {
          this.className = this.className.split(' ').filter(value => value && value !== name).concat(enabled ? name : []).join(' ');
        },
      };
    }
    get isConnected() { return this.root || Boolean(this.parentNode?.isConnected); }
    get children() { return this.nodes.filter(node => node instanceof Element); }
    get firstChild() { return this.nodes[0]; }
    get firstElementChild() { return this.children[0]; }
    get lastElementChild() { return this.children.at(-1); }
    get scrollWidth() { return this.textContent.length * 8; }
    getBoundingClientRect() { return { width: this.scrollWidth }; }
    get textContent() { return this.nodes.map(node => node.textContent).join(''); }
    set textContent(value) {
      for (const child of this.nodes) child.parentNode = null;
      this.nodes = [];
      if (value) this.appendChild(new Text(value)); else changed();
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.nodes.splice(child.parentNode.nodes.indexOf(child), 1);
      child.parentNode = this; this.nodes.push(child); changed(); return child;
    }
    append(...children) { for (const child of children) this.appendChild(child); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
  }
  class Observer {
    constructor(callback) { this.callback = callback; this.active = false; this.observed = new Set(); observers.push(this); }
    observe(element) { this.active = true; this.observed.add(element); }
    unobserve(element) { this.observed.delete(element); }
    disconnect() { this.active = false; this.observed.clear(); }
  }
  class Mutation extends Observer { constructor(callback) { super(callback); mutation = this; } }
  const document = {
    body: new Element(),
    createElement: () => new Element(),
    querySelectorAll: selector => { observedSelector = selector; return roots.filter(node => node.isConnected); },
    addEventListener: (name, handler) => { handlers[name] = handler; },
  };
  for (const title of titles) {
    const label = new Element(); label.root = true; label.textContent = title; roots.push(label);
  }
  const window = { addEventListener: (name, handler) => { handlers[name] = handler; } };
  vm.runInNewContext(source, {
    document, window, MutationObserver: Mutation, ResizeObserver: Observer,
    IntersectionObserver: Observer, requestAnimationFrame: callback => queue.push(callback),
  });
  function flush() {
    let turns = 0;
    while (queue.length) {
      assert.ok(++turns < 8, 'Own DOM mutations settle without an observer loop');
      queue.shift()();
    }
  }
  flush();
  return { roots, window, handlers, observers, flush, get selector() { return observedSelector; } };
}

test('overflow repeats one complete label while keeping accessible text and guide comparisons singular', () => {
  const title = 'A Television Show With A Long Episode Title';
  const p = labels(title), label = p.roots[0];
  assert.ok(p.selector.includes('.channel-now'), 'Now-airing show names participate');
  assert.ok(p.selector.includes('#now-title'), 'The current channel heading participates');
  assert.equal(label.classList.contains('is-overflowing'), true);
  const track = label.firstElementChild, copy = track.lastElementChild;
  assert.equal(label.textContent, title);
  assert.equal(copy.getAttribute('aria-hidden'), 'true');
  assert.equal(copy.getAttribute('data-scroll-text'), title);
  assert.equal(label.style.values['--scroll-distance'], `${title.length * 8 + 32}px`);
  for (let i = 0; i < 10; i++) { p.window.CharliflixScrollText.refresh(); p.flush(); }
  assert.equal(label.firstElementChild, track, 'Refreshes preserve the current animation track');
  assert.equal(track.children.length, 2, 'Refreshes do not multiply copies');
  assert.equal(label.textContent, title, 'Guide equality checks still see exactly one title');
});

test('programme changes replace both the original title and its visual repeat', () => {
  const p = labels('The Initial Long Programme Name'), label = p.roots[0];
  label.textContent = 'The Newly Airing Programme Has Another Long Title'; p.flush();
  assert.equal(label.firstElementChild.firstElementChild.textContent, label.textContent);
  assert.equal(label.firstElementChild.lastElementChild.getAttribute('data-scroll-text'), label.textContent);
  assert.equal(label.children.length, 1);
});

test('short and hidden-width labels stay still, and resizing reevaluates overflow', () => {
  const p = labels('Short', 'This Is A Long Title'), [short, long] = p.roots;
  assert.equal(short.classList.contains('is-overflowing'), false);
  long.clientWidth = 0; p.window.CharliflixScrollText.refresh(); p.flush();
  assert.equal(long.classList.contains('is-overflowing'), false);
  long.clientWidth = 70; p.handlers.resize(); p.flush();
  assert.equal(long.classList.contains('is-overflowing'), true);
});

test('removed guide rows are unobserved and page exit disconnects every observer', () => {
  const p = labels('A Long Title Inside A Guide Row'), label = p.roots[0];
  label.root = false; p.window.CharliflixScrollText.refresh(); p.flush();
  for (const observer of p.observers.filter(observer => observer !== p.observers.at(-1))) assert.equal(observer.observed.has(label), false);
  p.handlers.pagehide();
  assert.ok(p.observers.every(observer => !observer.active && observer.observed.size === 0));
});
