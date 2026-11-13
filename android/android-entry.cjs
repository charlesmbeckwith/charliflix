'use strict';

// Started once by the native application. The ready file is private app storage;
// only this process's successfully bound loopback listener is ever advertised.
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('./server.cjs');
const { version } = require('./package.json');

const readyFile = process.argv[2];
const requested = Number(process.argv[3]);
if (!readyFile || !path.isAbsolute(readyFile) || !Number.isInteger(requested) || requested < 1024 || requested > 65535) {
  throw new Error('Invalid native startup configuration.');
}
const server = createServer({ host: '127.0.0.1', root: __dirname });
let fallback = false;
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && !fallback) {
    fallback = true;
    server.listen(0, '127.0.0.1');
  } else {
    console.error('The Android local player could not start.');
    process.exitCode = 1;
  }
});
server.on('listening', () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(path.dirname(readyFile), { recursive: true });
  const temporary = `${readyFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ origin, version, nodeVersion: process.version }), { mode: 0o600 });
  fs.renameSync(temporary, readyFile);
});
server.listen(requested, '127.0.0.1');
