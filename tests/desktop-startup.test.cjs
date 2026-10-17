'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
let fixture;

test.before(async () => {
  if (process.platform !== 'win32') return;
  const artifacts = path.join(root, '.test-artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const directory = await fs.mkdtemp(path.join(artifacts, 'desktop-startup-'));
  fixture = path.join(directory, 'DesktopStartupChecks.exe');
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await run(compiler, [
    '/nologo', '/target:exe', '/platform:x64', '/langversion:5', `/out:${fixture}`,
    path.join(root, 'desktop', 'DesktopStartup.cs'), path.join(__dirname, 'fixtures', 'DesktopStartupChecks.cs'),
  ], { windowsHide: true, timeout: 20000 });
});

for (const name of ['loopback-origin', 'exit-before-error', 'both-streams-drained', 'eof-before-exit', 'ready-preserved', 'stderr-bounded']) {
  test(`Windows native startup: ${name}`, { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
    const result = await run(fixture, [name], { windowsHide: true, timeout: 15000 });
    assert.match(result.stdout, /passed/);
    assert.equal(result.stderr, '');
  });
}
