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
