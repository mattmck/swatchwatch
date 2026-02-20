const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT_PATH = path.resolve(
  __dirname,
  '../../../.husky/detect-changes.sh'
);

function runDetectChanges(changedFiles) {
  try {
    const output = execFileSync('sh', [SCRIPT_PATH, changedFiles], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    return output.trim().split('\n').reduce((acc, line) => {
      const [key, value] = line.split('=');
      acc[key] = value === 'true';
      return acc;
    }, {});
  } catch (error) {
    throw new Error(`Script execution failed: ${error.message}`);
  }
}

test('detect-changes.sh: detects shared package changes', () => {
  const result = runDetectChanges('packages/shared/src/types/polish.ts');

  assert.equal(result.BUILD_SHARED, true, 'should build shared package');
  assert.equal(result.BUILD_WEB, true, 'should build web (depends on shared)');
  assert.equal(result.BUILD_FUNCTIONS, true, 'should build functions (depends on shared)');
  assert.equal(result.VALIDATE_INFRA, false, 'should not validate infra');
});

test('detect-changes.sh: detects web app changes', () => {
  const result = runDetectChanges('apps/web/src/app/page.tsx');

  assert.equal(result.BUILD_SHARED, false, 'should not build shared');
  assert.equal(result.BUILD_WEB, true, 'should build web');
  assert.equal(result.BUILD_FUNCTIONS, false, 'should not build functions');
  assert.equal(result.VALIDATE_INFRA, false, 'should not validate infra');
});

test('detect-changes.sh: detects functions package changes', () => {
  const result = runDetectChanges('packages/functions/src/functions/polishes.ts');

  assert.equal(result.BUILD_SHARED, false, 'should not build shared');
  assert.equal(result.BUILD_WEB, false, 'should not build web');
  assert.equal(result.BUILD_FUNCTIONS, true, 'should build functions');
  assert.equal(result.VALIDATE_INFRA, false, 'should not validate infra');
});

test('detect-changes.sh: detects infrastructure changes', () => {
  const result = runDetectChanges('infrastructure/main.tf');

  assert.equal(result.BUILD_SHARED, false, 'should not build shared');
  assert.equal(result.BUILD_WEB, false, 'should not build web');
  assert.equal(result.BUILD_FUNCTIONS, false, 'should not build functions');
  assert.equal(result.VALIDATE_INFRA, true, 'should validate infra');
});

test('detect-changes.sh: detects root package.json changes', () => {
  const result = runDetectChanges('package.json');

  assert.equal(result.BUILD_SHARED, true, 'should build shared');
  assert.equal(result.BUILD_WEB, true, 'should build web');
  assert.equal(result.BUILD_FUNCTIONS, true, 'should build functions');
  assert.equal(result.VALIDATE_INFRA, false, 'should not validate infra');
});

test('detect-changes.sh: detects shared package.json changes', () => {
  const result = runDetectChanges('packages/shared/package.json');

  assert.equal(result.BUILD_SHARED, true, 'should build shared');
  assert.equal(result.BUILD_WEB, true, 'should build web (depends on shared)');
  assert.equal(result.BUILD_FUNCTIONS, true, 'should build functions (depends on shared)');
  assert.equal(result.VALIDATE_INFRA, false, 'should not validate infra');
});

test('detect-changes.sh: detects web package.json changes', () => {
  const result = runDetectChanges('apps/web/package.json');

  assert.equal(result.BUILD_SHARED, false, 'should not build shared');
  assert.equal(result.BUILD_WEB, true, 'should build web');
  assert.equal(result.BUILD_FUNCTIONS, false, 'should not build functions');
  assert.equal(result.VALIDATE_INFRA, false, 'should not validate infra');
});

test('detect-changes.sh: detects functions package.json changes', () => {
  const result = runDetectChanges('packages/functions/package.json');

  assert.equal(result.BUILD_SHARED, false, 'should not build shared');
  assert.equal(result.BUILD_WEB, false, 'should not build web');
  assert.equal(result.BUILD_FUNCTIONS, true, 'should build functions');
  assert.equal(result.VALIDATE_INFRA, false, 'should not validate infra');
});

test('detect-changes.sh: detects package-lock.json changes', () => {
  const result = runDetectChanges('package-lock.json');

  assert.equal(result.BUILD_SHARED, true, 'should build shared');
  assert.equal(result.BUILD_WEB, true, 'should build web');
  assert.equal(result.BUILD_FUNCTIONS, true, 'should build functions');
  assert.equal(result.VALIDATE_INFRA, false, 'should not validate infra');
});

test('detect-changes.sh: handles multiple changed files', () => {
  const result = runDetectChanges(
    'apps/web/src/app/page.tsx\npackages/functions/src/functions/auth.ts\ninfrastructure/variables.tf'
  );

  assert.equal(result.BUILD_SHARED, false, 'should not build shared');
  assert.equal(result.BUILD_WEB, true, 'should build web');
  assert.equal(result.BUILD_FUNCTIONS, true, 'should build functions');
  assert.equal(result.VALIDATE_INFRA, true, 'should validate infra');
});

test('detect-changes.sh: handles documentation changes (no builds)', () => {
  const result = runDetectChanges('README.md\nCONTRIBUTING.md');

  assert.equal(result.BUILD_SHARED, false, 'should not build shared');
  assert.equal(result.BUILD_WEB, false, 'should not build web');
  assert.equal(result.BUILD_FUNCTIONS, false, 'should not build functions');
  assert.equal(result.VALIDATE_INFRA, false, 'should not validate infra');
});

test('detect-changes.sh: propagates shared changes to dependents', () => {
  // When shared changes, web and functions must rebuild even if not changed
  const result = runDetectChanges('packages/shared/src/index.ts');

  assert.equal(result.BUILD_SHARED, true, 'should build shared');
  assert.equal(result.BUILD_WEB, true, 'should build web due to shared dependency');
  assert.equal(result.BUILD_FUNCTIONS, true, 'should build functions due to shared dependency');
  assert.equal(result.VALIDATE_INFRA, false, 'should not validate infra');
});