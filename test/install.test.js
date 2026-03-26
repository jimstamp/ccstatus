import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_SCRIPT = join(__dirname, '..', 'install.js');

let fakeHome;
let claudeDir;
let settingsPath;

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), 'ccstatus-install-test-'));
  claudeDir = join(fakeHome, '.claude');
  settingsPath = join(claudeDir, 'settings.json');
});

afterEach(async () => {
  await rm(fakeHome, { recursive: true, force: true });
});

async function runInstall(env = {}) {
  const { stdout, stderr } = await exec('node', [INSTALL_SCRIPT], {
    env: {
      ...process.env,
      HOME: fakeHome,
      ...env,
    },
    timeout: 5000,
  });
  return { stdout, stderr };
}

describe('install script', () => {
  it('creates ~/.claude directory', async () => {
    await runInstall();
    const s = await stat(claudeDir);
    assert.ok(s.isDirectory());
  });

  it('copies statusline.sh to ~/.claude/', async () => {
    await runInstall();
    const dest = join(claudeDir, 'statusline.sh');
    const s = await stat(dest);
    assert.ok(s.isFile());
    // Check it's executable (owner execute bit)
    assert.ok((s.mode & 0o100) !== 0);
  });

  it('creates settings.json with statusLine config', async () => {
    await runInstall();
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.deepEqual(settings.statusLine, {
      type: 'command',
      command: '~/.claude/statusline.sh',
      padding: 2,
    });
  });

  it('preserves existing settings.json keys', async () => {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ theme: 'dark', other: true }, null, 2));
    await runInstall();
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.other, true);
    assert.ok(settings.statusLine);
  });

  it('is idempotent — does not rewrite if already configured', async () => {
    await runInstall();
    const first = await readFile(settingsPath, 'utf8');
    const { stdout } = await runInstall();
    const second = await readFile(settingsPath, 'utf8');
    assert.equal(first, second);
    assert.ok(stdout.includes('already configured'));
  });

  it('backs up corrupt settings.json', async () => {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(settingsPath, 'not valid json{{{');
    await runInstall();
    // Backup should exist
    const backup = await readFile(settingsPath + '.bak', 'utf8');
    assert.equal(backup, 'not valid json{{{');
    // Settings should now be valid
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.ok(settings.statusLine);
  });

  it('reports dependency check results', async () => {
    const { stdout } = await runInstall();
    assert.ok(stdout.includes('Dependency check'));
    assert.ok(stdout.includes('jq'));
  });
});
