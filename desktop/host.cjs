'use strict';

// The native window owns this bridge. EOF also cleans up after a window crash.
const { stop } = require('../launch.cjs');
const { startDesktop } = require('./runtime.cjs');
const { version } = require('../package.json');
const path = require('node:path');
const { runtimeDirectory } = require('../launch.cjs');
let result;
let closing = false;
let finished = false;
let startup;
const originalLog = console.log;
console.log = () => {};
const send = (value, callback) => process.stdout.write(`${JSON.stringify(value)}\n`, callback);

async function close() {
  if (closing) return;
  closing = true;
  let cleanupFailed = false;
  let stopped = false;
  try {
    await startup;
    if (!result) throw new Error('The local player did not finish starting.');
    // Stop only the backend created by this bridge, never another listener.
    if (result.pid) stopped = (await stop({ port: result.port, expectedPid: result.pid, runtimeDirectory: result.runtimeDirectory })).stopped;
  } catch (error) {
    cleanupFailed = true;
    send({ type: 'cleanup-error', message: error.message });
  } finally {
    // The native updater requires this positive acknowledgement as well as a
    // clean exit. An exited/crashed bridge alone cannot prove its child stopped.
    await new Promise(resolve => send({ type: 'closed', success: !cleanupFailed, ownsServer: Boolean(result?.pid), stopped }, resolve));
    finished = true;
    process.stdin.pause();
    process.exit(cleanupFailed ? 1 : 0);
  }
}

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', chunk => {
  input = (input + chunk).slice(-256);
  if (input.includes('\n')) close();
});
process.stdin.on('end', close);
process.on('SIGINT', close);
process.on('SIGTERM', close);
process.stdin.resume();
startup = startDesktop({ port: Number(process.env.CHANNEL_ROOM_PORT || 8767) }).then(value => {
  result = value;
  if (!closing) send({ type: 'ready', url: value.url, ownsServer: Boolean(value.pid), version, directory: path.resolve(__dirname, '..'), runtimeDirectory: runtimeDirectory() });
}).catch(async error => {
  // Native startup waits for the drained output stream. Flush the specific
  // failure before exit so it is not replaced by a generic process-exit error.
  await new Promise(resolve => send({ type: 'error', message: error.message }, resolve));
  if (!closing) { finished = true; process.stdin.pause(); process.exit(1); }
});
process.on('exit', () => { if (!finished) console.log = originalLog; });
