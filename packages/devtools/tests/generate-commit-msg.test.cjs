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

function exec(cmd, args, options) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function git(cwd, ...args) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return exec('git', args, { cwd, env });
}

async function initRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swatchwatch-commitmsg-'));
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

test('generate-commit-msg.sh: generates suggestions with emojis after the type', async () => {
  const repoDir = await initRepo();

  // Stage a change so git diff --cached has output.
  await writeFile(repoDir, 'src/example.ts', 'export const x = 1;\n');
  git(repoDir, 'add', 'src/example.ts');

  // Fake "claude" binary so the script takes the "claude CLI" path.
  const binDir = path.join(repoDir, 'bin');
  await fs.mkdir(binDir, { recursive: true });

  const promptCaptureFile = path.join(repoDir, 'prompt.txt');
  const claudePath = path.join(binDir, 'claude');
  await fs.writeFile(
    claudePath,
    `#!/usr/bin/env sh\ncat > "${promptCaptureFile}"\ncat >/dev/null\nprintf "%s\\n" \\\n  "feat: ✨ add shimmer finish to swatch cards" \\\n  "fix: polish swatch rendering edge cases" \\\n  "docs: add glossy API notes 💅"\n`
  );
  exec('chmod', ['+x', claudePath], { cwd: repoDir });

  const commitMsgFile = path.join(repoDir, 'COMMIT_EDITMSG');

  exec('sh', [SCRIPT_PATH, commitMsgFile], {
    cwd: repoDir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      ANTHROPIC_API_KEY: 'test_key',
    },
  });

  const out = await fs.readFile(commitMsgFile, 'utf8');
  const suggestionLines = out
    .split('\n')
    .filter((l) => l.startsWith('# - '))
    .map((l) => l.replace(/^# - /, '').trim());

  assert.equal(suggestionLines.length, 3);

  for (const line of suggestionLines) {
    assert.match(line, /^(feat|fix|refactor|docs|chore|test|style): /);
    // Ensure no emoji appears before the type prefix.
    assert.doesNotMatch(line, /^[^:]*[✨💅].*:/);
  }

  const prompt = await fs.readFile(promptCaptureFile, 'utf8');
  assert.match(prompt, /vibey Conventional Commit suggestions/i);
  assert.match(prompt, /Never put emoji before the type/i);
  assert.match(prompt, /after <type>: \)/i);
});

test('generate-commit-msg.sh: generates fallback suggestions for package.json changes', async () => {
  const repoDir = await initRepo();

  await writeFile(repoDir, 'package.json', '{"name":"tmp"}\n');
  git(repoDir, 'add', 'package.json');

  const commitMsgFile = path.join(repoDir, 'COMMIT_EDITMSG');

  // Force the fallback branch by ensuring we have no Anthropic API key and no "claude" in PATH.
  exec('sh', [SCRIPT_PATH, commitMsgFile], {
    cwd: repoDir,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    },
  });

  const out = await fs.readFile(commitMsgFile, 'utf8');
  // Should generate package.json-aware suggestions
  assert.match(out, /# - chore:.*dependenc/i);
  // Should also include a suggestion mentioning the actual file
  assert.match(out, /package/i);
});
