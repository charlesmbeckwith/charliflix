'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/android-controls.js'), 'utf8');

function player(android = true) {
  const handlers = {};
  const classes = new Set();
  const elements = [];
  let modal = null, revealed = 0;
  const document = {
    body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
    activeElement: null,
    addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); },
    getElementById: id => elements.find(element => element.id === id),
    querySelector: selector => selector === 'dialog[open]' ? modal : selector === '.stage' ? { dispatchEvent: () => revealed++ } : null,
    querySelectorAll: selector => selector === 'dialog[open]' ? (modal || []) : selector === '.channel-card' ? elements.filter(element => element.channel) : elements,
  };
  function add(id, x, y, options = {}) {
    const element = { id, ...options, clicks: 0, scrolled: 0,
      disabled: options.disabled || false,
      getAttribute: name => name === 'aria-pressed' ? String(Boolean(element.selected)) : null,
      getClientRects: () => element.hidden ? [] : [{}],
      getBoundingClientRect: () => ({ left: x, top: y, width: 80, height: 44, right: x + 80, bottom: y + 44 }),
      matches: selector => selector.startsWith('.channel-card') ? element.channel && element.selected : selector.startsWith('input[type=') ? element.range : selector.startsWith('button,a[href]') ? !element.range && !element.editing : false,
      closest: () => element.editing ? element : null,
      focus: () => { document.activeElement = element; },
      scrollIntoView: () => element.scrolled++,
      click: () => { element.clicks++; if (element.channel) { for (const item of elements) item.selected = item === element; } },
    };
    elements.push(element);
    return element;
  }
  const context = { document, window: { navigator: { userAgent: android ? 'Mozilla/5.0 CharliflixAndroid/0.3.8' : 'Mozilla/5.0' } }, Event: class Event { constructor(type) { this.type = type; } } };
  vm.runInNewContext(source, context, { filename: 'public/android-controls.js' });
  return { add, classes, document,
    get revealed() { return revealed; },
    modal(...choices) { modal = [{ querySelectorAll: () => choices }]; },
    overlay(...choices) { (modal ??= []).push({ querySelectorAll: () => choices }); },
    key(key, extras = {}) {
      const event = { key, target: document.activeElement, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extras };
      for (const handler of handlers.keydown || []) handler(event);
      return event;
    },
    touch() { for (const handler of handlers.pointerdown || []) handler(); },
  };
}

test('Android D-pad focuses the selected channel then aligned visible neighbors and activates with A/Enter', () => {
  const p = player();
  const first = p.add('channel-1', 0, 100, { channel: true, selected: true });
  const second = p.add('channel-2', 0, 180, { channel: true });
  p.add('hidden', 0, 150, { hidden: true });
  p.add('disabled', 0, 160, { disabled: true });
  const play = p.add('play-toggle', 200, 180);
  assert.equal(p.key('ArrowDown').defaultPrevented, true);
  assert.equal(p.document.activeElement, first);
  p.key('ArrowDown');
  assert.equal(p.document.activeElement, second);
  assert.equal(p.key('Enter').defaultPrevented, true);
  assert.equal(second.clicks, 1);
  assert.equal(p.key('Enter', { repeat: true }).defaultPrevented, false);
  assert.equal(second.clicks, 1, 'holding A does not retune repeatedly');
  p.key('ArrowRight');
  assert.equal(p.document.activeElement, play);
  assert.ok(p.revealed > 0);
  assert.ok(p.classes.has('controller-navigation'));
  p.touch();
  assert.equal(p.classes.has('controller-navigation'), false);
});

test('controller channel shortcuts wrap the lineup but leave an open guide alone', () => {
  const p = player();
  const first = p.add('channel-1', 0, 100, { channel: true, selected: true });
  const second = p.add('channel-2', 0, 180, { channel: true });
  assert.equal(p.key('PageUp').defaultPrevented, true);
  assert.equal(second.clicks, 1);
  p.key('PageDown');
  assert.equal(first.clicks, 1);
  const close = p.add('close', 200, 10);
  const show = p.add('show', 200, 100);
  p.modal(close, show);
  assert.equal(p.key('PageDown').defaultPrevented, false);
  p.document.activeElement = first;
  p.key('ArrowDown');
  assert.equal(p.document.activeElement, close, 'focus cannot leave the modal');
  p.key('ArrowDown');
  assert.equal(p.document.activeElement, show);
});

test('controller navigation preserves editing, range adjustment, modifiers and prior handlers', () => {
  const p = player();
  const range = p.add('volume', 0, 100, { range: true });
  const next = p.add('next', 0, 200);
  p.document.activeElement = range;
  assert.equal(p.key('ArrowLeft').defaultPrevented, false);
  assert.equal(p.key('ArrowRight').defaultPrevented, false);
  p.key('ArrowDown');
  assert.equal(p.document.activeElement, next);
  const select = p.add('feed', 0, 300, { editing: true });
  p.document.activeElement = select;
  for (const key of ['ArrowDown', 'Enter', 'PageUp', 'MediaPlayPause']) assert.equal(p.key(key).defaultPrevented, false);
  p.document.activeElement = next;
  for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { defaultPrevented: true }]) {
    p.key('ArrowUp', extra);
    assert.equal(p.document.activeElement, next);
  }
});

test('episode details on top of the guide retain controller focus and block channel shortcuts', () => {
  const p = player();
  const channel = p.add('channel', 0, 100, { channel: true, selected: true });
  const guideClose = p.add('guide-close', 200, 10);
  const detailsClose = p.add('details-close', 300, 10);
  const mark = p.add('mark-watched', 300, 100);
  p.modal(guideClose); p.overlay(detailsClose, mark);
  p.document.activeElement = channel; p.key('ArrowDown');
  assert.equal(p.document.activeElement, detailsClose);
  p.key('ArrowDown'); p.key('Enter');
  assert.equal(mark.clicks, 1);
  assert.equal(p.key('PageDown').defaultPrevented, false);
  assert.equal(channel.clicks, 0);
});

test('the settings PiP checkbox accepts controller A and keeps D-pad navigation usable', () => {
  const p = player();
  const checkbox = p.add('settings-pip', 100, 100, { checkbox:true });
  const close = p.add('close-settings', 100, 200);
  p.modal(checkbox, close); p.document.activeElement = checkbox;
  assert.equal(p.key('Enter').defaultPrevented, true);
  assert.equal(checkbox.clicks, 1);
  p.key('ArrowDown');
  assert.equal(p.document.activeElement, close);
});

test('media play key activates the ordinary control and desktop browsers remain unchanged', () => {
  const p = player();
  const play = p.add('play-toggle', 200, 100);
  assert.equal(p.key('MediaPlayPause').defaultPrevented, true);
  assert.equal(play.clicks, 1);
  const desktop = player(false);
  const channel = desktop.add('channel', 0, 0, { channel: true, selected: true });
  assert.equal(desktop.key('ArrowDown').defaultPrevented, false);
  assert.equal(desktop.key('PageDown').defaultPrevented, false);
  assert.equal(channel.clicks, 0);
  assert.equal(desktop.classes.size, 0);
});
