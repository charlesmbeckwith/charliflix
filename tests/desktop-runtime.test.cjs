'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startDesktop, readSavedPort, rememberPort, MAX_ATTEMPTS } = require('../desktop/runtime.cjs');

async function fixture(t) {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'charliflix-desktop-port-'));
  t.after(() => fs.rm(runtime, { recursive: true, force: true }));
  return runtime;
}

function busy() {
  const error = new Error('Test listener already occupies this port.');
  error.code = 'EPLAYER_PORT_BUSY';
  return error;
}

function owned(port) { return { port, url: `http://127.0.0.1:${port}`, pid: 12345 }; }

test('desktop port selection bounds collision retries and never retries other errors', async t => {
  const runtime = await fixture(t);
  let starts = 0;
  let selections = 0;
  await assert.rejects(startDesktop({ port: 42001, runtimeDirectory: runtime }, {
    startPlayer: async options => { starts++; assert.equal(options.requireOwned, true); throw busy(); },
    selectFreePort: async () => { selections++; return 42001 + selections; },
  }), { code: 'EPLAYER_PORT_BUSY' });
  assert.equal(starts, MAX_ATTEMPTS);
  assert.equal(selections, MAX_ATTEMPTS - 1);
  assert.equal(await readSavedPort(runtime), null);
  const fatal = new Error('The packaged player dependencies are missing.');
  starts = 0;
  selections = 0;
  await assert.rejects(startDesktop({ port: 42001, runtimeDirectory: runtime }, {
    startPlayer: async () => { starts++; throw fatal; },
    selectFreePort: async () => { selections++; return 42002; },
  }), error => error === fatal);
  assert.equal(starts, 1);
  assert.equal(selections, 0);
});

test('desktop port selection preserves the chosen origin when the preferred port becomes available', async t => {
  const runtime = await fixture(t);
  const calls = [];
  const first = await startDesktop({ port: 42001, runtimeDirectory: runtime }, {
    startPlayer: async options => { calls.push(options); if (options.port === 42001) throw busy(); return owned(options.port); },
    selectFreePort: async () => 42002,
  });
  assert.equal(first.port, 42002);
  assert.equal(await readSavedPort(runtime), 42002);
  const second = await startDesktop({ port: 42001, runtimeDirectory: runtime }, {
    startPlayer: async options => { calls.push(options); return owned(options.port); },
    selectFreePort: async () => { throw new Error('A saved free port must be tried first.'); },
  });
  assert.equal(second.url, first.url);
  assert.deepEqual(calls.map(options => options.port), [42001, 42002, 42002]);
  assert(calls.every(options => options.requireOwned && options.open === false && options.runtimeDirectory === runtime));
  assert.deepEqual(await fs.readdir(runtime), ['desktop-port.json']);
});

test('desktop saved connection record rejects corrupt, oversized and foreign path/host values', async t => {
  const runtime = await fixture(t);
  const file = path.join(runtime, 'desktop-port.json');
  const valid = { application: 'channel-room', schema: 1, host: '127.0.0.1', port: 42002, runtimeDirectory: runtime };
  const invalid = [
    '{', 'x'.repeat(4097), JSON.stringify(null),
    ...[
      { application: 'another-application' }, { schema: 2 }, { host: 'localhost' },
      { host: '0.0.0.0' }, { port: 0 }, { port: 65536 }, { port: '42002' },
      { runtimeDirectory: path.join(runtime, 'another-profile') }, { runtimeDirectory: 'relative-profile' },
    ].map(change => JSON.stringify({ ...valid, ...change })),
  ];
  for (const value of invalid) {
    await fs.writeFile(file, value);
    assert.equal(await readSavedPort(runtime), null);
    const result = await startDesktop({ port: 42001, runtimeDirectory: runtime }, {
      startPlayer: async options => owned(options.port),
      selectFreePort: async () => { throw new Error('An invalid saved record must not supply a candidate.'); },
    });
    assert.equal(result.port, 42001);
  }
  await rememberPort(runtime, 42002);
  assert.equal(await readSavedPort(runtime), 42002);
  assert.deepEqual(await fs.readdir(runtime), ['desktop-port.json']);
});

test('desktop stops only its newly owned server if saving the connection fails', async t => {
  const runtime = await fixture(t);
  // A directory cannot be atomically replaced by the port record file.
  await fs.mkdir(path.join(runtime, 'desktop-port.json'));
  const stops = [];
  await assert.rejects(startDesktop({ port: 42001, runtimeDirectory: runtime }, {
    startPlayer: async options => owned(options.port),
    stopPlayer: async options => { stops.push(options); return { stopped: true }; },
  }), /desktop connection could not be saved/);
  assert.deepEqual(stops, [{ port: 42001, expectedPid: 12345, runtimeDirectory: runtime }]);
  assert.deepEqual(await fs.readdir(runtime), ['desktop-port.json']);
});
