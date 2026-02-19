const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

test('README.md exists and has required sections', async () => {
  const readmePath = path.resolve(__dirname, '../README.md');
  const content = await fs.readFile(readmePath, 'utf8');

  // Check for essential sections
  assert.match(content, /# .* SwatchWatch/, 'Should have main heading with SwatchWatch');
  assert.match(content, /## Architecture/i, 'Should have Architecture section');
  assert.match(content, /## Quick Start/i, 'Should have Quick Start section');
  assert.match(content, /## Environment Variables/i, 'Should have Environment Variables section');
});

test('README.md documents all workspaces', async () => {
  const readmePath = path.resolve(__dirname, '../README.md');
  const content = await fs.readFile(readmePath, 'utf8');

  // Should mention all workspaces
  assert.match(content, /apps\/web/i, 'Should document web app');
  assert.match(content, /apps\/mobile/i, 'Should document mobile app');
  assert.match(content, /packages\/functions/i, 'Should document functions package');
  assert.match(content, /packages\/shared/i, 'Should document shared package');
  assert.match(content, /infrastructure/i, 'Should document infrastructure');
});

test('CONTRIBUTING.md has git workflow documentation', async () => {
  const contributingPath = path.resolve(__dirname, '../CONTRIBUTING.md');
  const content = await fs.readFile(contributingPath, 'utf8');

  assert.match(content, /## Git Workflow/i, 'Should have Git Workflow section');
  assert.match(content, /Conventional Commits/i, 'Should reference Conventional Commits');
  assert.match(content, /## Branch Naming/i, 'Should document branch naming');
  assert.match(content, /feat\//i, 'Should document feat/ prefix');
  assert.match(content, /fix\//i, 'Should document fix/ prefix');
});

test('CLAUDE.md has agent instructions', async () => {
  const claudePath = path.resolve(__dirname, '../CLAUDE.md');
  const content = await fs.readFile(claudePath, 'utf8');

  assert.match(content, /## Architecture Overview/i, 'Should have Architecture Overview');
  assert.match(content, /## Dev Commands/i, 'Should document dev commands');
  assert.match(content, /## Key Conventions/i, 'Should document conventions');
  assert.match(content, /TypeScript strict mode/i, 'Should mention TypeScript strict mode');
});

test('Agent instruction symlinks point to CLAUDE.md', async () => {
  const symlinks = [
    '.cursorrules',
    '.windsurfrules',
    '.github/copilot-instructions.md',
  ];

  for (const link of symlinks) {
    const linkPath = path.resolve(__dirname, '..', link);
    const stats = await fs.lstat(linkPath);
    assert.ok(stats.isSymbolicLink(), `${link} should be a symbolic link`);

    const target = await fs.readlink(linkPath);
    assert.match(target, /CLAUDE\.md$/, `${link} should point to CLAUDE.md`);
  }
});

test('.husky/README.md documents git hooks', async () => {
  const huskyReadmePath = path.resolve(__dirname, '../.husky/README.md');
  const content = await fs.readFile(huskyReadmePath, 'utf8');

  assert.match(content, /## Hooks/i, 'Should have Hooks section');
  assert.match(content, /prepare-commit-msg/i, 'Should document prepare-commit-msg hook');
  assert.match(content, /pre-commit/i, 'Should document pre-commit hook');
  assert.match(content, /Conventional Commits/i, 'Should reference Conventional Commits');
  assert.match(content, /AI-Powered Commit Messages/i, 'Should document AI-powered features');
});

test('apps/web/README.md documents web app structure', async () => {
  const webReadmePath = path.resolve(__dirname, '../apps/web/README.md');
  const content = await fs.readFile(webReadmePath, 'utf8');

  assert.match(content, /## Route Structure/i, 'Should have Route Structure section');
  assert.match(content, /## Components/i, 'Should have Components section');
  assert.match(content, /## Auth System/i, 'Should document auth system');
  assert.match(content, /shadcn\/ui/i, 'Should mention shadcn/ui');
});

test('Documentation files have consistent structure', async () => {
  const docs = [
    '../README.md',
    '../CONTRIBUTING.md',
    '../CLAUDE.md',
    '../apps/web/README.md',
  ];

  for (const doc of docs) {
    const docPath = path.resolve(__dirname, doc);
    const content = await fs.readFile(docPath, 'utf8');

    // Should have markdown headings
    assert.match(content, /^#\s+/m, `${doc} should have markdown headings`);

    // Should not be empty
    assert.ok(content.length > 100, `${doc} should have substantial content`);

    // Should have proper line endings (no excessive blank lines at end)
    assert.ok(!content.endsWith('\n\n\n'), `${doc} should not have excessive trailing newlines`);
  }
});

test('Merge planning documents exist and reference dev branch', async () => {
  const mergePlanPath = path.resolve(__dirname, '../DEV_MERGE_PLAN.md');
  const mergeStatusPath = path.resolve(__dirname, '../MERGE_STATUS.md');

  const planContent = await fs.readFile(mergePlanPath, 'utf8');
  const statusContent = await fs.readFile(mergeStatusPath, 'utf8');

  assert.match(planContent, /origin\/dev/i, 'Merge plan should reference origin/dev');
  assert.match(statusContent, /merge/i, 'Merge status should document merge details');
});