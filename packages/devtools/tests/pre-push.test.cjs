const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const PRE_PUSH_PATH = path.resolve(__dirname, '../../../.husky/pre-push');
const DETECT_CHANGES_PATH = path.resolve(__dirname, '../../../.husky/detect-changes.sh');

test('pre-push: script file exists and is executable', async () => {
  const stats = await fs.stat(PRE_PUSH_PATH);
  assert.ok(stats.isFile(), 'pre-push should be a file');

  // Check if file has execute permissions (on Unix systems)
  if (process.platform !== 'win32') {
    const mode = stats.mode;
    const isExecutable = (mode & 0o111) !== 0;
    assert.ok(isExecutable, 'pre-push should be executable');
  }
});

test('pre-push: sources detect-changes.sh', async () => {
  const content = await fs.readFile(PRE_PUSH_PATH, 'utf8');

  assert.match(
    content,
    /\.\s+".*detect-changes\.sh"/,
    'pre-push should source detect-changes.sh'
  );
});

test('pre-push: has shebang for shell execution', async () => {
  const content = await fs.readFile(PRE_PUSH_PATH, 'utf8');
  const lines = content.split('\n');

  assert.match(
    lines[0],
    /^#!.*sh$/,
    'pre-push should start with #!/usr/bin/env sh or similar'
  );
});

test('pre-push: calls detect_changes function', async () => {
  const content = await fs.readFile(PRE_PUSH_PATH, 'utf8');

  assert.match(
    content,
    /detect_changes\s+"?\$CHANGED_FILES"?/,
    'pre-push should call detect_changes with CHANGED_FILES'
  );
});

test('pre-push: builds shared package when BUILD_SHARED is true', async () => {
  const content = await fs.readFile(PRE_PUSH_PATH, 'utf8');

  assert.match(
    content,
    /if\s+\[\s+"\$BUILD_SHARED"\s+=\s+true\s+\]/,
    'pre-push should check BUILD_SHARED flag'
  );

  assert.match(
    content,
    /npm run build --workspace=packages\/shared/,
    'pre-push should build shared package'
  );
});

test('pre-push: builds web app when BUILD_WEB is true', async () => {
  const content = await fs.readFile(PRE_PUSH_PATH, 'utf8');

  assert.match(
    content,
    /if\s+\[\s+"\$BUILD_WEB"\s+=\s+true\s+\]/,
    'pre-push should check BUILD_WEB flag'
  );

  assert.match(
    content,
    /npm run build:web/,
    'pre-push should build web app'
  );
});

test('pre-push: builds functions when BUILD_FUNCTIONS is true', async () => {
  const content = await fs.readFile(PRE_PUSH_PATH, 'utf8');

  assert.match(
    content,
    /if\s+\[\s+"\$BUILD_FUNCTIONS"\s+=\s+true\s+\]/,
    'pre-push should check BUILD_FUNCTIONS flag'
  );

  assert.match(
    content,
    /npm run build:functions/,
    'pre-push should build functions package'
  );
});

test('pre-push: validates infrastructure when VALIDATE_INFRA is true', async () => {
  const content = await fs.readFile(PRE_PUSH_PATH, 'utf8');

  assert.match(
    content,
    /if\s+\[\s+"\$VALIDATE_INFRA"\s+=\s+true\s+\]/,
    'pre-push should check VALIDATE_INFRA flag'
  );

  assert.match(
    content,
    /terraform\s+(init|validate)/,
    'pre-push should run terraform validate'
  );
});

test('pre-push: exits early when no changes detected', async () => {
  const content = await fs.readFile(PRE_PUSH_PATH, 'utf8');

  assert.match(
    content,
    /if\s+\[\s+-z\s+"\$CHANGED_FILES"\s+\]/,
    'pre-push should check for empty CHANGED_FILES'
  );

  assert.match(
    content,
    /exit\s+0/,
    'pre-push should exit 0 when no changes'
  );
});

test('pre-push: dependency order - shared builds before web and functions', async () => {
  const content = await fs.readFile(PRE_PUSH_PATH, 'utf8');

  const sharedIndex = content.indexOf('npm run build --workspace=packages/shared');
  const webIndex = content.indexOf('npm run build:web');
  const functionsIndex = content.indexOf('npm run build:functions');

  if (sharedIndex !== -1 && webIndex !== -1) {
    assert.ok(
      sharedIndex < webIndex,
      'shared should build before web'
    );
  }

  if (sharedIndex !== -1 && functionsIndex !== -1) {
    assert.ok(
      sharedIndex < functionsIndex,
      'shared should build before functions'
    );
  }
});

test('pre-push: propagates shared changes to dependent packages', async () => {
  const content = await fs.readFile(PRE_PUSH_PATH, 'utf8');

  // The script should set BUILD_WEB=true and BUILD_FUNCTIONS=true when shared changes
  const sharedBlock = content.match(
    /if\s+\[\s+"\$BUILD_SHARED"\s+=\s+true\s+\];?\s+then([\s\S]*?)fi/
  );

  if (sharedBlock && sharedBlock[1]) {
    const blockContent = sharedBlock[1];
    assert.match(
      blockContent,
      /BUILD_WEB=true/,
      'pre-push should set BUILD_WEB=true when shared changes'
    );
    assert.match(
      blockContent,
      /BUILD_FUNCTIONS=true/,
      'pre-push should set BUILD_FUNCTIONS=true when shared changes'
    );
  }
});

test('detect-changes.sh: dependency file exists and is readable', async () => {
  const stats = await fs.stat(DETECT_CHANGES_PATH);
  assert.ok(stats.isFile(), 'detect-changes.sh should be a file');

  const content = await fs.readFile(DETECT_CHANGES_PATH, 'utf8');
  assert.ok(content.length > 0, 'detect-changes.sh should not be empty');
});