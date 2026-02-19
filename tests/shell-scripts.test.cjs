const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

test('.husky/generate-commit-msg.sh has proper shebang', async () => {
  const scriptPath = path.resolve(__dirname, '../.husky/generate-commit-msg.sh');
  const content = await fs.readFile(scriptPath, 'utf8');

  assert.match(content, /^#!\/usr\/bin\/env sh/m, 'Should have portable sh shebang');
});

test('.husky/generate-commit-msg.sh unsets git environment variables', async () => {
  const scriptPath = path.resolve(__dirname, '../.husky/generate-commit-msg.sh');
  const content = await fs.readFile(scriptPath, 'utf8');

  // Should unset GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE for reliable git operations
  assert.match(content, /unset GIT_DIR/i, 'Should unset GIT_DIR');
  assert.match(content, /unset GIT_WORK_TREE/i, 'Should unset GIT_WORK_TREE');
  assert.match(content, /unset GIT_INDEX_FILE/i, 'Should unset GIT_INDEX_FILE');
});

test('.husky/generate-commit-msg.sh handles Anthropic API key', async () => {
  const scriptPath = path.resolve(__dirname, '../.husky/generate-commit-msg.sh');
  const content = await fs.readFile(scriptPath, 'utf8');

  assert.match(content, /ANTHROPIC_API_KEY/i, 'Should check for ANTHROPIC_API_KEY');
  assert.match(content, /fallback/i, 'Should have fallback when API key is not available');
});

test('.husky/generate-commit-msg.sh generates conventional commit suggestions', async () => {
  const scriptPath = path.resolve(__dirname, '../.husky/generate-commit-msg.sh');
  const content = await fs.readFile(scriptPath, 'utf8');

  // Should generate suggestions matching conventional commit format
  const commitTypes = ['feat', 'fix', 'refactor', 'docs', 'chore', 'test', 'style'];
  for (const type of commitTypes) {
    assert.match(content, new RegExp(type, 'i'), `Should handle ${type} commit type`);
  }
});

test('.husky/pre-push sources detect-changes.sh', async () => {
  const scriptPath = path.resolve(__dirname, '../.husky/pre-push');
  const content = await fs.readFile(scriptPath, 'utf8');

  assert.match(content, /\. .*detect-changes\.sh/i, 'Should source detect-changes.sh');
});

test('.husky/pre-push validates builds before push', async () => {
  const scriptPath = path.resolve(__dirname, '../.husky/pre-push');
  const content = await fs.readFile(scriptPath, 'utf8');

  assert.match(content, /BUILD_SHARED/i, 'Should check if shared package needs building');
  assert.match(content, /BUILD_WEB/i, 'Should check if web app needs building');
  assert.match(content, /BUILD_FUNCTIONS/i, 'Should check if functions need building');
  assert.match(content, /VALIDATE_INFRA/i, 'Should check if infrastructure needs validation');
});

test('.husky/pre-push builds in correct order', async () => {
  const scriptPath = path.resolve(__dirname, '../.husky/pre-push');
  const content = await fs.readFile(scriptPath, 'utf8');

  // Shared should be built first since other packages depend on it
  const sharedIndex = content.indexOf('BUILD_SHARED');
  const webIndex = content.indexOf('BUILD_WEB');
  const functionsIndex = content.indexOf('BUILD_FUNCTIONS');

  assert.ok(sharedIndex < webIndex, 'Should check shared before web');
  assert.ok(sharedIndex < functionsIndex, 'Should check shared before functions');
});

test('Shell scripts have execute permissions', async () => {
  const scripts = [
    '../.husky/generate-commit-msg.sh',
    '../.husky/pre-push',
  ];

  for (const script of scripts) {
    const scriptPath = path.resolve(__dirname, script);
    try {
      const stats = await fs.stat(scriptPath);
      // Check if file has execute bit for owner (0o100)
      const hasExecute = (stats.mode & 0o100) !== 0;
      assert.ok(hasExecute, `${script} should have execute permission`);
    } catch (err) {
      // If stat fails, the file might not exist yet, which is ok
      if (err.code !== 'ENOENT') throw err;
    }
  }
});

test('Shell scripts use set -e or equivalent error handling', async () => {
  const scripts = [
    '../.husky/pre-push',
  ];

  for (const script of scripts) {
    const scriptPath = path.resolve(__dirname, script);
    const content = await fs.readFile(scriptPath, 'utf8');

    // Should exit on error (via '|| exit 1' or similar)
    const hasErrorHandling = content.includes('|| exit 1') ||
                             content.includes('set -e') ||
                             content.match(/if \[.*\]; then.*exit/s);

    assert.ok(hasErrorHandling, `${script} should have error handling`);
  }
});