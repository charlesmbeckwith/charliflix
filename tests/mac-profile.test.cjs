'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../mac/main.cjs'), 'utf8');

for (const exists of [false, true]) test(`Mac branding preserves an existing profile without requiring one on first launch (${exists})`, () => {
  const overrides = [], names = [];
  const app = { getPath: () => '/profiles', setPath: (name, target) => { assert.equal(exists, true, 'Electron cannot set a missing profile directory'); overrides.push({ name, target }); }, setName: name => names.push(name), requestSingleInstanceLock: () => false, quit() {} };
  vm.runInNewContext(source, { require: name => {
    if (name === 'electron') return { app };
    if (name === 'node:fs') return { existsSync: () => exists };
    if (name === 'node:path') return path;
    if (name.startsWith('.')) return {};
    throw new Error('Unexpected import');
  } }, { filename: 'mac/main.cjs' });
  assert.deepEqual(names, ['Charliflix']);
  assert.equal(overrides.length, exists ? 1 : 0);
  if (exists) assert.deepEqual(overrides[0], { name: 'userData', target: path.join('/profiles', 'Channel Room') });
});

test('the actual Mac window handler opens approved attribution externally only from the owned app document', async () => {
  const external = [];
  let handler;
  let documentUrl = 'http://127.0.0.1:8767/';
  const app = { getPath: () => '/profiles', getAppPath: () => '/application', setName() {}, requestSingleInstanceLock: () => true, quit() {}, on() {}, whenReady: async () => {} };
  class BrowserWindow {
    constructor() {
      this.webContents = { getURL: () => documentUrl, setWindowOpenHandler: fn => { handler = fn; }, on() {} };
    }
    once() {}
    async loadURL() {}
    isDestroyed() { return false; }
    show() {}
  }
  const ses = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, webRequest: { onBeforeRequest() {} } };
  vm.runInNewContext(source, { __dirname: path.join(__dirname, '../mac'), process: { platform: 'darwin' }, console, require: name => {
    if (name === 'electron') return { app, BrowserWindow, dialog: { showErrorBox: (_title, detail) => { throw new Error(detail); } }, session: { defaultSession: ses }, Menu: { buildFromTemplate: () => [], setApplicationMenu() {} },
      shell: { openExternal: async url => { external.push(url); } }, ipcMain: { on() {} } };
    if (name === 'node:fs') return { existsSync: () => false };
    if (name === 'node:path') return path;
    if (name === '../server.cjs') return {};
    if (name === './runtime.cjs') return { ...require('../mac/runtime.cjs'), startOwnedServer: async () => ({ origin: 'http://127.0.0.1:8767', usedFallbackPort: false, close: async () => {} }) };
    if (name === './updates.cjs') return { createUpdateNotifications: () => ({ start() {}, request() {}, close() {} }) };
    throw new Error('Unexpected import: ' + name);
  } }, { filename: 'mac/main.cjs' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof handler, 'function');
  const attribution = 'https://epgtalk.com/api.html';
  assert.equal(handler({ url: attribution }).action, 'deny', 'no child window is ever created');
  assert.deepEqual(external, [attribution]);
  for (documentUrl of ['https://attacker.example/', 'http://127.0.0.1:8767/api/health']) handler({ url: attribution });
  documentUrl = 'http://127.0.0.1:8767/index.html';
  handler({ url: 'https://epgtalk.com/api.html?redirect=elsewhere' });
  handler({ url: 'https://github.com/charlesmbeckwith/charliflix/releases/latest' });
  assert.deepEqual(external, [attribution, 'https://github.com/charlesmbeckwith/charliflix/releases/latest']);
});
