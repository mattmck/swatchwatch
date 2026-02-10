const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const SCRIPT_PATH = path.resolve(
  __dirname,
  '../../../.husky/generate-commit-msg.sh'
);

// Minimal PATH with system essentials (sed, head, etc.) but no claude/curl/jq
const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

// Clean env for git commands: strip GIT_* vars that leak from pre-commit hooks
// (e.g. GIT_INDEX_FILE, GIT_DIR) which break temp repo isolation.
const CLEAN_GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

function exec(cmd, args, options) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function git(cwd, ...args) {
  return exec('git', args, { cwd, env: CLEAN_GIT_ENV });
}

async function initRepo() {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'swatchwatch-commitmsg-')
  );
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  return dir;
}

async function writeFile(repoDir, relPath, contents) {
  const abs = path.join(repoDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
  return abs;
}

async function stageFile(repoDir) {
  await writeFile(repoDir, 'src/example.ts', 'export const x = 1;\n');
  git(repoDir, 'add', 'src/example.ts');
}

/**
 * Create a fake "claude" binary that outputs canned suggestions.
 * The fake binary validates it receives the expected -p flag and args.
 */
async function makeFakeClaude(repoDir) {
  const binDir = path.join(repoDir, 'bin');
  await fs.mkdir(binDir, { recursive: true });

  const argCaptureFile = path.join(repoDir, 'claude-args.txt');
  const claudePath = path.join(binDir, 'claude');
  // Capture all args so we can verify flags. Output 3 canned suggestions.
  await fs.writeFile(
    claudePath,
    [
      '#!/usr/bin/env sh',
      `printf "%s\\n" "$@" > "${argCaptureFile}"`,
      'printf "%s\\n" \\',
      '  "feat: ✨ add shimmer finish to swatch cards" \\',
      '  "fix: polish swatch rendering edge cases" \\',
      '  "docs: add glossy API notes 💅"',
    ].join('\n') + '\n'
  );
  exec('chmod', ['+x', claudePath], { cwd: repoDir });

  return { binDir, argCaptureFile };
}

/**
 * Find the system jq binary path, or null if not installed.
 */
function findJq() {
  try {
    return exec('which', ['jq']).trim();
  } catch {
    return null;
  }
}

/**
 * Create a fake "curl" that returns a canned API response.
 * Also symlinks real jq into binDir so the PATH stays isolated
 * (no extra dirs that might contain claude).
 */
async function makeFakeCurl(repoDir, { format = 'anthropic' } = {}) {
  const binDir = path.join(repoDir, 'bin');
  await fs.mkdir(binDir, { recursive: true });

  // Symlink real jq into our isolated binDir
  const jqPath = findJq();
  if (jqPath) {
    const jqLink = path.join(binDir, 'jq');
    try { await fs.symlink(jqPath, jqLink); } catch { /* already exists */ }
  }

  const urlCaptureFile = path.join(repoDir, 'curl-url.txt');
  const curlPath = path.join(binDir, 'curl');

  let jsonResponse;
  if (format === 'anthropic') {
    jsonResponse = JSON.stringify({
      content: [
        {
          text: [
            'feat: ✨ add shimmer finish to swatch cards',
            'fix: polish swatch rendering edge cases',
            'docs: add glossy API notes 💅',
          ].join('\n'),
        },
      ],
    });
  } else {
    // openai format
    jsonResponse = JSON.stringify({
      choices: [
        {
          message: {
            content: [
              'feat: ✨ add shimmer finish to swatch cards',
              'fix: polish swatch rendering edge cases',
              'docs: add glossy API notes 💅',
            ].join('\n'),
          },
        },
      ],
    });
  }

  // Capture all args so we can verify the URL; output canned JSON
  await fs.writeFile(
    curlPath,
    [
      '#!/usr/bin/env sh',
      `printf "%s\\n" "$@" > "${urlCaptureFile}"`,
      `printf '%s' '${jsonResponse.replace(/'/g, "'\\''")}'`,
    ].join('\n') + '\n'
  );
  exec('chmod', ['+x', curlPath], { cwd: repoDir });

  return { binDir, urlCaptureFile };
}

// --- Tests ---

test('Claude CLI provider: uses claude -p with correct flags', async () => {
  const repoDir = await initRepo();
  await stageFile(repoDir);
  const { binDir, argCaptureFile } = await makeFakeClaude(repoDir);

  const commitMsgFile = path.join(repoDir, 'COMMIT_EDITMSG');

  exec('sh', [SCRIPT_PATH, commitMsgFile], {
    cwd: repoDir,
    env: {
      PATH: `${binDir}:${BARE_PATH}`,
      HOME: os.homedir(),
    },
  });

  // Verify claude was called with expected flags
  const capturedArgs = await fs.readFile(argCaptureFile, 'utf8');
  assert.match(capturedArgs, /-p/);
  assert.match(capturedArgs, /--model/);
  assert.match(capturedArgs, /haiku/);
  assert.match(capturedArgs, /--max-turns/);
  assert.match(capturedArgs, /1/);

  // Verify output has suggestions
  const out = await fs.readFile(commitMsgFile, 'utf8');
  const suggestionLines = out
    .split('\n')
    .filter((l) => l.startsWith('# - '))
    .map((l) => l.replace(/^# - /, '').trim());

  assert.equal(suggestionLines.length, 3);
  for (const line of suggestionLines) {
    assert.match(line, /^(feat|fix|refactor|docs|chore|test|style): /);
  }

  // Verify provider label
  assert.match(out, /claude-cli/);
});

test('Anthropic API provider: used when no claude CLI but ANTHROPIC_API_KEY set', async () => {
  const repoDir = await initRepo();
  await stageFile(repoDir);

  if (!findJq()) return; // skip if jq not installed

  // binDir has fake curl + symlinked jq, but NO claude
  const { binDir, urlCaptureFile } = await makeFakeCurl(repoDir, {
    format: 'anthropic',
  });

  const commitMsgFile = path.join(repoDir, 'COMMIT_EDITMSG');

  exec('sh', [SCRIPT_PATH, commitMsgFile], {
    cwd: repoDir,
    env: {
      PATH: `${binDir}:${BARE_PATH}`,
      HOME: os.homedir(),
      ANTHROPIC_API_KEY: 'sk-test-key',
    },
  });

  // Verify curl was called with Anthropic URL
  const capturedUrl = await fs.readFile(urlCaptureFile, 'utf8');
  assert.match(capturedUrl, /api\.anthropic\.com/);

  // Verify output
  const out = await fs.readFile(commitMsgFile, 'utf8');
  assert.match(out, /anthropic-api/);
  const suggestionLines = out
    .split('\n')
    .filter((l) => l.startsWith('# - '));
  assert.equal(suggestionLines.length, 3);
});

test('OpenAI API provider: used when no claude CLI, no ANTHROPIC_API_KEY, but OPENAI_API_KEY set', async () => {
  const repoDir = await initRepo();
  await stageFile(repoDir);

  if (!findJq()) return; // skip if jq not installed

  // binDir has fake curl + symlinked jq, but NO claude
  const { binDir, urlCaptureFile } = await makeFakeCurl(repoDir, {
    format: 'openai',
  });

  const commitMsgFile = path.join(repoDir, 'COMMIT_EDITMSG');

  exec('sh', [SCRIPT_PATH, commitMsgFile], {
    cwd: repoDir,
    env: {
      PATH: `${binDir}:${BARE_PATH}`,
      HOME: os.homedir(),
      OPENAI_API_KEY: 'sk-test-key',
    },
  });

  // Verify curl was called with OpenAI URL
  const capturedUrl = await fs.readFile(urlCaptureFile, 'utf8');
  assert.match(capturedUrl, /api\.openai\.com/);

  // Verify output
  const out = await fs.readFile(commitMsgFile, 'utf8');
  assert.match(out, /openai-api/);
  const suggestionLines = out
    .split('\n')
    .filter((l) => l.startsWith('# - '));
  assert.equal(suggestionLines.length, 3);
});

test('Manual fallback: no AI available produces write-your-own message', async () => {
  const repoDir = await initRepo();
  await stageFile(repoDir);

  const commitMsgFile = path.join(repoDir, 'COMMIT_EDITMSG');

  // No claude in PATH, no API keys
  exec('sh', [SCRIPT_PATH, commitMsgFile], {
    cwd: repoDir,
    env: {
      PATH: BARE_PATH,
      HOME: os.homedir(),
    },
  });

  const out = await fs.readFile(commitMsgFile, 'utf8');

  // Should NOT have any suggestion lines
  const suggestionLines = out
    .split('\n')
    .filter((l) => l.startsWith('# - '));
  assert.equal(suggestionLines.length, 0, 'Manual fallback should not generate suggestions');

  // Should have the "no AI provider" message
  assert.match(out, /No AI provider available/);
  assert.match(out, /write your commit message/i);

  // Should mention setup options
  assert.match(out, /Claude Code CLI/);
  assert.match(out, /Anthropic API key/);
  assert.match(out, /OpenAI API key/);
});

test('Claude CLI fallback: falls through to next provider on failure', async () => {
  const repoDir = await initRepo();
  await stageFile(repoDir);

  // Create a claude binary that fails (exits non-zero with no output)
  const binDir = path.join(repoDir, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const claudePath = path.join(binDir, 'claude');
  await fs.writeFile(claudePath, '#!/usr/bin/env sh\nexit 1\n');
  exec('chmod', ['+x', claudePath], { cwd: repoDir });

  const commitMsgFile = path.join(repoDir, 'COMMIT_EDITMSG');

  // Claude CLI will fail, no API keys → should fall to manual
  exec('sh', [SCRIPT_PATH, commitMsgFile], {
    cwd: repoDir,
    env: {
      PATH: `${binDir}:${BARE_PATH}`,
      HOME: os.homedir(),
    },
  });

  const out = await fs.readFile(commitMsgFile, 'utf8');
  assert.match(out, /No AI provider available/);
});

test('No staged changes: outputs informational comment only', async () => {
  const repoDir = await initRepo();

  const commitMsgFile = path.join(repoDir, 'COMMIT_EDITMSG');
  await fs.writeFile(commitMsgFile, '');

  exec('sh', [SCRIPT_PATH, commitMsgFile], {
    cwd: repoDir,
    env: {
      PATH: BARE_PATH,
      HOME: os.homedir(),
    },
  });

  const out = await fs.readFile(commitMsgFile, 'utf8');
  assert.match(out, /No staged changes/);
});
