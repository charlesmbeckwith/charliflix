'use strict';

// The native window owns this bridge. EOF also cleans up after a window crash.
const { start, stop } = require('../launch.cjs');
let result;
let closing = false;
let finished = false;
let startup;
const originalLog = console.log;
console.log = () => {};
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);

async function close() {
  if (closing) return;
  closing = true;
  try {
    await startup;
    // An existing browser/server session belongs to its original launcher.
    if (result?.pid) await stop({ port: result.port, expectedPid: result.pid });
  } catch (error) {
    send({ type: 'cleanup-error', message: error.message });
  } finally {
    finished = true;
    process.stdin.pause();
    process.exit(0);
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
startup = start({ open: false, port: Number(process.env.CHANNEL_ROOM_PORT || 8767) }).then(value => {
  result = value;
  if (!closing) send({ type: 'ready', url: value.url, ownsServer: Boolean(value.pid) });
}).catch(error => {
  send({ type: 'error', message: error.message });
  if (!closing) { finished = true; process.exit(1); }
});
process.on('exit', () => { if (!finished) console.log = originalLog; });
