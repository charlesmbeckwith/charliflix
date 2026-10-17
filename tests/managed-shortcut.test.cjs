'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('managed Windows installation preserves installer shortcuts without starting the app', { skip: process.platform !== 'win32' }, async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'charliflix-shortcut-'));
  const current = path.join(fixture, 'current');
  const desktop = path.join(current, 'desktop');
  try {
    await fs.mkdir(desktop, { recursive: true });
    await fs.writeFile(path.join(fixture, 'Update.exe'), 'fixture, never executed');
    await fs.writeFile(path.join(current, 'sq.version'), '<package><metadata><id>Charliflix</id></metadata></package>');
    const script = path.join(desktop, 'Install-Desktop.ps1');
    await fs.copyFile(path.join(__dirname, '..', 'desktop', 'Install-Desktop.ps1'), script);
    // There is deliberately no main executable: this must finish without a launch.
    const result = await promisify(execFile)('pwsh.exe', ['-NoProfile', '-File', script, '-StartMenu'], { windowsHide: true, timeout: 10000 });
    assert.match(result.stdout, /managed by its installer/);
    assert.match(result.stdout, /No shortcut was created/);
    assert.deepEqual((await fs.readdir(current)).sort(), ['desktop', 'sq.version']);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
