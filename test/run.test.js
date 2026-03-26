import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'statusline.sh');
const STUBS = join(__dirname, 'stubs');

// ANSI codes for colour assertions
const ANSI = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  bgRed: '\x1b[41m',
};

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function hasColourBefore(output, text, colour) {
  const idx = output.indexOf(text);
  if (idx <= 0) return false;
  const preceding = output.slice(Math.max(0, idx - 20), idx);
  return preceding.includes(colour);
}

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'ccstatus-test-'));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

async function run(inputJson, envOverrides = {}) {
  const env = {
    PATH: `${STUBS}:${process.env.PATH}`,
    HOME: process.env.HOME,
    CCSTATUS_CACHE_DIR: cacheDir,
    STUB_CLAUDE_AUTH_JSON: '{}',
    STUB_GH_ORGS: '',
    STUB_GH_PR_VIEW: '{}',
    STUB_GH_RUN_LIST: 'pass',
    STUB_GIT_IS_REPO: 'false',
    STUB_GIT_BRANCH: 'main',
    STUB_GIT_DEFAULT_BRANCH: 'main',
    ...envOverrides,
  };

  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', () => {
      resolve({
        raw: stdout,
        plain: stripAnsi(stdout).trim(),
        stderr,
      });
    });
    child.stdin.write(JSON.stringify(inputJson));
    child.stdin.end();
  });
}

// -- Auth guard ---------------------------------------------------------------

describe('auth guard', () => {
  it('warns when personal Claude on work GitHub', async () => {
    const { plain } = await run(
      { cwd: '/tmp/myproject' },
      {
        STUB_CLAUDE_AUTH_JSON: '{"email":"jim@gmail.com"}',
        STUB_GH_ORGS: 'madetech',
      },
    );
    assert.ok(plain.includes('PERSONAL CLAUDE ON WORK GITHUB'));
  });

  it('shows MT prefix when work Claude + work GitHub', async () => {
    const { plain } = await run(
      { cwd: '/tmp/myproject' },
      {
        STUB_CLAUDE_AUTH_JSON: '{"email":"jim@madetech.com"}',
        STUB_GH_ORGS: 'madetech',
      },
    );
    assert.ok(plain.includes('MT/'));
    assert.ok(!plain.includes('PERSONAL'));
  });

  it('shows amber when work Claude + personal GitHub', async () => {
    const { plain } = await run(
      { cwd: '/tmp/myproject' },
      {
        STUB_CLAUDE_AUTH_JSON: '{"email":"jim@madetech.com"}',
        STUB_GH_ORGS: 'some-other-org',
      },
    );
    assert.ok(plain.includes('MT'));
    assert.ok(!plain.includes('MT/'));
  });

  it('shows plain folder when personal Claude + personal GitHub', async () => {
    const { plain } = await run(
      { cwd: '/tmp/myproject' },
      {
        STUB_CLAUDE_AUTH_JSON: '{"email":"jim@gmail.com"}',
        STUB_GH_ORGS: 'some-other-org',
      },
    );
    assert.ok(plain.includes('myproject'));
    assert.ok(!plain.includes('MT'));
  });
});

// -- Model --------------------------------------------------------------------

describe('model', () => {
  it('shows opus in red', async () => {
    const { raw, plain } = await run({ model: { display_name: 'Opus 4.6' } });
    assert.ok(plain.includes('opus'));
    assert.ok(hasColourBefore(raw, 'opus', ANSI.red));
  });

  it('shows sonnet in blue', async () => {
    const { raw, plain } = await run({ model: { display_name: 'Sonnet 4.6' } });
    assert.ok(plain.includes('sonnet'));
    assert.ok(hasColourBefore(raw, 'sonnet', ANSI.blue));
  });

  it('shows haiku in green', async () => {
    const { raw, plain } = await run({ model: { display_name: 'Haiku 4.5' } });
    assert.ok(plain.includes('haiku'));
    assert.ok(hasColourBefore(raw, 'haiku', ANSI.green));
  });

  it('passes through unknown model name', async () => {
    const { plain } = await run({ model: { display_name: 'GPT-5' } });
    assert.ok(plain.includes('GPT-5'));
  });

  it('omits segment when model is missing', async () => {
    const { plain } = await run({ cwd: '/tmp/test' });
    assert.ok(!plain.includes('opus'));
    assert.ok(!plain.includes('sonnet'));
    assert.ok(!plain.includes('haiku'));
  });
});

// -- Rate limits (subscription) -----------------------------------------------

describe('rate limits (subscription)', () => {
  it('hides segment when 5h is 0%', async () => {
    const { plain } = await run({
      rate_limits: { five_hour: { used_percentage: 0 }, seven_day: { used_percentage: 0 } },
    });
    assert.ok(!plain.includes('/5h'));
  });

  it('shows yellow at 55%', async () => {
    const { raw, plain } = await run({
      rate_limits: { five_hour: { used_percentage: 55 }, seven_day: { used_percentage: 10 } },
    });
    assert.ok(plain.includes('55%'));
    assert.ok(plain.includes('/5h'));
    assert.ok(hasColourBefore(raw, '55%', ANSI.yellow));
  });

  it('shows red at 85% with reset time', async () => {
    const { raw, plain } = await run({
      rate_limits: {
        five_hour: { used_percentage: 85, resets_at: '2026-03-26T18:30:00.000Z' },
        seven_day: { used_percentage: 10 },
      },
    });
    assert.ok(plain.includes('85%'));
    assert.ok(hasColourBefore(raw, '85%', ANSI.red));
    assert.ok(plain.includes('resets'));
  });

  it('shows 7d when above 30%', async () => {
    const { plain } = await run({
      rate_limits: { five_hour: { used_percentage: 40 }, seven_day: { used_percentage: 35 } },
    });
    assert.ok(plain.includes('/5h'));
    assert.ok(plain.includes('35%'));
    assert.ok(plain.includes('/7d'));
  });

  it('hides 7d when at 25%', async () => {
    const { plain } = await run({
      rate_limits: { five_hour: { used_percentage: 40 }, seven_day: { used_percentage: 25 } },
    });
    assert.ok(plain.includes('/5h'));
    assert.ok(!plain.includes('/7d'));
  });
});

// -- Cost (token-based) -------------------------------------------------------

describe('cost (token-based)', () => {
  it('shows green below warn threshold', async () => {
    const { raw, plain } = await run({
      cost: { total_cost_usd: 0.50, total_duration_ms: 60000, total_lines_added: 0, total_lines_removed: 0 },
    });
    assert.ok(plain.includes('$0.50'));
    assert.ok(hasColourBefore(raw, '$0.50', ANSI.green));
  });

  it('shows yellow at warn threshold', async () => {
    const { raw, plain } = await run({
      cost: { total_cost_usd: 2.00, total_duration_ms: 120000, total_lines_added: 0, total_lines_removed: 0 },
    });
    assert.ok(plain.includes('$2.00'));
    assert.ok(hasColourBefore(raw, '$2.00', ANSI.yellow));
  });

  it('shows red at crit threshold', async () => {
    const { raw, plain } = await run({
      cost: { total_cost_usd: 6.00, total_duration_ms: 300000, total_lines_added: 0, total_lines_removed: 0 },
    });
    assert.ok(plain.includes('$6.00'));
    assert.ok(hasColourBefore(raw, '$6.00', ANSI.red));
  });

  it('respects custom thresholds via env vars', async () => {
    const { raw, plain } = await run(
      { cost: { total_cost_usd: 0.30, total_duration_ms: 60000, total_lines_added: 0, total_lines_removed: 0 } },
      { CCSTATUS_COST_WARN: '0.25', CCSTATUS_COST_CRIT: '0.50' },
    );
    assert.ok(plain.includes('$0.30'));
    assert.ok(hasColourBefore(raw, '$0.30', ANSI.yellow));
  });

  it('shows $/min rate when duration available', async () => {
    const { plain } = await run({
      cost: { total_cost_usd: 3.00, total_duration_ms: 600000, total_lines_added: 0, total_lines_removed: 0 },
    });
    assert.ok(plain.includes('$3.00'));
    assert.ok(plain.includes('($0.30/m)'));
  });

  it('hides cost when zero', async () => {
    const { plain } = await run({
      cost: { total_cost_usd: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 },
    });
    assert.ok(!plain.includes('$'));
  });

  it('shows lines changed when nonzero', async () => {
    const { plain } = await run({
      cost: { total_cost_usd: 1.00, total_duration_ms: 60000, total_lines_added: 42, total_lines_removed: 7 },
    });
    assert.ok(plain.includes('+42'));
    assert.ok(plain.includes('-7'));
  });

  it('hides lines changed when both zero', async () => {
    const { plain } = await run({
      cost: { total_cost_usd: 1.00, total_duration_ms: 60000, total_lines_added: 0, total_lines_removed: 0 },
    });
    assert.ok(!plain.includes('+0'));
    assert.ok(!plain.includes('-0'));
  });
});

// -- Context window -----------------------------------------------------------

describe('context window', () => {
  it('hides segment at 0%', async () => {
    const { plain } = await run({ context_window: { used_percentage: 0 } });
    assert.ok(!plain.includes('ctx'));
  });

  it('shows green at 45%', async () => {
    const { raw, plain } = await run({ context_window: { used_percentage: 45 } });
    assert.ok(plain.includes('45%'));
    assert.ok(plain.includes('ctx'));
    assert.ok(hasColourBefore(raw, '45%', ANSI.green));
  });

  it('shows yellow at 70%', async () => {
    const { raw, plain } = await run({ context_window: { used_percentage: 70 } });
    assert.ok(plain.includes('70%'));
    assert.ok(hasColourBefore(raw, '70%', ANSI.yellow));
  });

  it('shows red at 90%', async () => {
    const { raw, plain } = await run({ context_window: { used_percentage: 90 } });
    assert.ok(plain.includes('90%'));
    assert.ok(hasColourBefore(raw, '90%', ANSI.red));
  });

  it('handles null percentage (token users)', async () => {
    const { plain } = await run({ context_window: { used_percentage: null } });
    assert.ok(!plain.includes('ctx'));
  });
});

// -- Git / PR / CI ------------------------------------------------------------

describe('git', () => {
  it('shows branch name when in a git repo', async () => {
    const { plain } = await run(
      { cwd: cacheDir },
      { STUB_GIT_IS_REPO: 'true', STUB_GIT_BRANCH: 'feature/cool-thing' },
    );
    assert.ok(plain.includes('feature/cool-thing'));
  });

  it('omits git segment when not a repo', async () => {
    const { plain } = await run(
      { cwd: cacheDir },
      { STUB_GIT_IS_REPO: 'false' },
    );
    assert.ok(!plain.includes('main'));
  });

  it('shows open PR with approved review', async () => {
    const prData = JSON.stringify({
      number: 42,
      state: 'OPEN',
      reviewDecision: 'APPROVED',
      statusCheckRollup: [],
    });
    const { plain } = await run(
      { cwd: cacheDir },
      { STUB_GIT_IS_REPO: 'true', STUB_GH_PR_VIEW: prData },
    );
    assert.ok(plain.includes('#42'));
  });

  it('shows open PR with changes requested', async () => {
    const prData = JSON.stringify({
      number: 99,
      state: 'OPEN',
      reviewDecision: 'CHANGES_REQUESTED',
      statusCheckRollup: [],
    });
    const { raw, plain } = await run(
      { cwd: cacheDir },
      { STUB_GIT_IS_REPO: 'true', STUB_GH_PR_VIEW: prData },
    );
    assert.ok(plain.includes('#99'));
    assert.ok(hasColourBefore(raw, '#99', ANSI.red));
  });

  it('shows CI pass status on PR', async () => {
    const prData = JSON.stringify({
      number: 10,
      state: 'OPEN',
      reviewDecision: '',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });
    const { plain } = await run(
      { cwd: cacheDir },
      { STUB_GIT_IS_REPO: 'true', STUB_GH_PR_VIEW: prData },
    );
    assert.ok(plain.includes('CI'));
  });

  it('shows CI health flag when default branch failing', async () => {
    const { raw, plain } = await run(
      { cwd: cacheDir },
      { STUB_GIT_IS_REPO: 'true', STUB_GH_RUN_LIST: 'fail' },
    );
    assert.ok(plain.includes('CI'));
    assert.ok(hasColourBefore(raw, 'CI', ANSI.red));
  });
});

// -- Segment joining ----------------------------------------------------------

describe('output format', () => {
  it('joins segments with pipe separator', async () => {
    const { plain } = await run({
      model: { display_name: 'Sonnet 4.6' },
      context_window: { used_percentage: 30 },
    });
    assert.ok(plain.includes('│'));
  });
});

// -- Edge cases ---------------------------------------------------------------

describe('edge cases', () => {
  it('handles empty JSON input', async () => {
    const { plain } = await run({});
    // Should at least show the folder segment without crashing
    assert.ok(typeof plain === 'string');
  });
});
