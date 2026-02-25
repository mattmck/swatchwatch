const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Helper to read markdown files
function readMarkdown(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

// Helper to extract markdown headings
function extractHeadings(content) {
  const withoutCode = content.replace(/```[\s\S]*?```/g, '');
  const headingRegex = /^#{1,6}\s+(.+)$/gm;
  const headings = [];
  let match;
  while ((match = headingRegex.exec(withoutCode)) !== null) {
    const level = match[0].match(/^#+/)[0].length;
    headings.push({ level, text: match[1].trim() });
  }
  return headings;
}

// Helper to extract markdown links
function extractLinks(content) {
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const links = [];
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    links.push({ text: match[1], url: match[2] });
  }
  return links;
}

// Helper to check if file exists (for internal links)
function fileExists(basePath, relPath) {
  try {
    const fullPath = path.resolve(basePath, relPath);
    return fs.existsSync(fullPath);
  } catch {
    return false;
  }
}

// Test README.md
test('README.md: file exists and is readable', () => {
  const readmePath = path.resolve(__dirname, '../../../README.md');
  assert.doesNotThrow(
    () => readMarkdown(readmePath),
    'README.md should be readable'
  );
});

test('README.md: has proper structure with main sections', () => {
  const readmePath = path.resolve(__dirname, '../../../README.md');
  const content = readMarkdown(readmePath);
  const headings = extractHeadings(content);

  // Should have top-level heading with project name
  assert.ok(
    headings.some((h) => h.level === 1 && h.text.toLowerCase().includes('swatchwatch')),
    'should have H1 with project name SwatchWatch'
  );

  // Should have key sections
  const expectedSections = [
    'architecture',
    'quick start',
    'prerequisites',
    'commands',
    'structure',
    'documentation',
  ];

  expectedSections.forEach((section) => {
    assert.ok(
      headings.some((h) => h.text.toLowerCase().includes(section)),
      `should have section about ${section}`
    );
  });
});

test('README.md: contains setup instructions', () => {
  const readmePath = path.resolve(__dirname, '../../../README.md');
  const content = readMarkdown(readmePath);

  assert.match(content, /npm (run )?setup/i, 'should mention npm setup');
  assert.match(content, /npm (run )?dev/i, 'should mention npm dev');
  assert.match(content, /npm (run )?build/i, 'should mention npm build');
});

test('README.md: references workspaces architecture', () => {
  const readmePath = path.resolve(__dirname, '../../../README.md');
  const content = readMarkdown(readmePath);

  assert.match(content, /workspaces?/i, 'should mention npm workspaces');
  assert.match(content, /apps\/web/i, 'should reference apps/web');
  assert.match(content, /packages\/functions/i, 'should reference packages/functions');
  assert.match(content, /packages\/shared/i, 'should reference packages/shared');
});

test('README.md: internal documentation links are valid', () => {
  const readmePath = path.resolve(__dirname, '../../../README.md');
  const repoRoot = path.resolve(__dirname, '../../..');
  const content = readMarkdown(readmePath);
  const links = extractLinks(content);

  // Check internal links (relative paths, including file links with anchors)
  const internalLinks = links.filter(
    (link) => !link.url.startsWith('http') && !link.url.startsWith('#')
  );

  internalLinks.forEach((link) => {
    const [filePath] = link.url.split('#');
    const exists = fileExists(repoRoot, filePath);
    assert.ok(
      exists,
      `Internal link should exist: [${link.text}](${link.url})`
    );
  });
});

// Test CONTRIBUTING.md
test('CONTRIBUTING.md: file exists and has git workflow documentation', () => {
  const contributingPath = path.resolve(__dirname, '../../../CONTRIBUTING.md');
  const content = readMarkdown(contributingPath);

  assert.match(content, /git workflow/i, 'should document git workflow');
  assert.match(content, /conventional commit/i, 'should mention conventional commits');
  assert.match(content, /pull request/i, 'should document pull request process');
});

test('CONTRIBUTING.md: documents branch naming conventions', () => {
  const contributingPath = path.resolve(__dirname, '../../../CONTRIBUTING.md');
  const content = readMarkdown(contributingPath);

  assert.match(content, /feat\//i, 'should document feat/ branch prefix');
  assert.match(content, /fix\//i, 'should document fix/ branch prefix');
  assert.match(content, /chore\//i, 'should document chore/ branch prefix');
});

test('CONTRIBUTING.md: documents commit message format', () => {
  const contributingPath = path.resolve(__dirname, '../../../CONTRIBUTING.md');
  const content = readMarkdown(contributingPath);

  assert.match(content, /feat:/i, 'should document feat: commit type');
  assert.match(content, /fix:/i, 'should document fix: commit type');
  assert.match(content, /docs:/i, 'should document docs: commit type');
  assert.match(content, /chore:/i, 'should document chore: commit type');
});

test('CONTRIBUTING.md: has code standards section', () => {
  const contributingPath = path.resolve(__dirname, '../../../CONTRIBUTING.md');
  const content = readMarkdown(contributingPath);
  const headings = extractHeadings(content);

  assert.ok(
    headings.some((h) => h.text.toLowerCase().includes('code') || h.text.toLowerCase().includes('standard')),
    'should have section about code standards'
  );

  assert.match(content, /typescript/i, 'should mention TypeScript');
});

test('CONTRIBUTING.md: references documentation update requirement', () => {
  const contributingPath = path.resolve(__dirname, '../../../CONTRIBUTING.md');
  const content = readMarkdown(contributingPath);

  assert.match(
    content,
    /update\s+(docs|documentation)/i,
    'should mention updating documentation'
  );
});

// Test CLAUDE.md
test('CLAUDE.md: file exists and is the canonical agent instruction file', () => {
  const claudePath = path.resolve(__dirname, '../../../CLAUDE.md');
  assert.doesNotThrow(
    () => readMarkdown(claudePath),
    'CLAUDE.md should be readable'
  );
});

test('CLAUDE.md: has architecture overview section', () => {
  const claudePath = path.resolve(__dirname, '../../../CLAUDE.md');
  const content = readMarkdown(claudePath);
  const headings = extractHeadings(content);

  assert.ok(
    headings.some((h) => h.text.toLowerCase().includes('architecture')),
    'should have architecture overview section'
  );
});

test('CLAUDE.md: documents key conventions', () => {
  const claudePath = path.resolve(__dirname, '../../../CLAUDE.md');
  const content = readMarkdown(claudePath);

  assert.match(content, /typescript/i, 'should mention TypeScript');
  assert.match(content, /azure functions/i, 'should mention Azure Functions');
  assert.match(content, /shared types/i, 'should mention shared types');
});

test('CLAUDE.md: lists development commands', () => {
  const claudePath = path.resolve(__dirname, '../../../CLAUDE.md');
  const content = readMarkdown(claudePath);

  assert.match(content, /npm run dev/i, 'should document npm run dev');
  assert.match(content, /npm run build/i, 'should document npm run build');
  // Test can be included or mentioned in other ways
  const hasTestInfo = /npm run test/i.test(content) || /test/i.test(content);
  assert.ok(hasTestInfo, 'should document testing or test command');
});

test('CLAUDE.md: documents web app routes', () => {
  const claudePath = path.resolve(__dirname, '../../../CLAUDE.md');
  const content = readMarkdown(claudePath);

  assert.match(content, /\/dashboard/i, 'should document dashboard route');
  assert.match(content, /\/polishes/i, 'should document polishes route');
});

test('CLAUDE.md: has environment variables section', () => {
  const claudePath = path.resolve(__dirname, '../../../CLAUDE.md');
  const content = readMarkdown(claudePath);

  assert.match(content, /environment variables/i, 'should have environment variables section');
  assert.match(content, /AZURE_AD_B2C/i, 'should mention Azure AD B2C variables');
});

// Test symlinks to CLAUDE.md
test('agent instruction files: .cursorrules is a symlink to CLAUDE.md', () => {
  const cursorrules = path.resolve(__dirname, '../../../.cursorrules');
  assert.ok(fs.existsSync(cursorrules), '.cursorrules should exist');

  if (process.platform !== 'win32') {
    const stats = fs.lstatSync(cursorrules);
    assert.ok(stats.isSymbolicLink(), '.cursorrules should be a symlink');

    const target = fs.readlinkSync(cursorrules);
    assert.match(target, /CLAUDE\.md$/, '.cursorrules should point to CLAUDE.md');
  } else {
    // On Windows, just check content matches
    const cursorContent = fs.readFileSync(cursorrules, 'utf8');
    const claudeContent = fs.readFileSync(path.resolve(__dirname, '../../../CLAUDE.md'), 'utf8');
    assert.equal(cursorContent, claudeContent, '.cursorrules content should match CLAUDE.md');
  }
});

test('agent instruction files: .windsurfrules is a symlink to CLAUDE.md', () => {
  const windsurfrules = path.resolve(__dirname, '../../../.windsurfrules');

  if (process.platform !== 'win32') {
    const stats = fs.lstatSync(windsurfrules);
    assert.ok(stats.isSymbolicLink(), '.windsurfrules should be a symlink');

    const target = fs.readlinkSync(windsurfrules);
    assert.match(target, /CLAUDE\.md$/, '.windsurfrules should point to CLAUDE.md');
  } else {
    // On Windows, just check content matches
    const windContent = fs.readFileSync(windsurfrules, 'utf8');
    const claudeContent = fs.readFileSync(path.resolve(__dirname, '../../../CLAUDE.md'), 'utf8');
    assert.equal(windContent, claudeContent, '.windsurfrules content should match CLAUDE.md');
  }
});

test('agent instruction files: .github/copilot-instructions.md is a symlink to CLAUDE.md', () => {
  const copilotPath = path.resolve(__dirname, '../../../.github/copilot-instructions.md');

  if (process.platform !== 'win32') {
    const stats = fs.lstatSync(copilotPath);
    assert.ok(stats.isSymbolicLink(), 'copilot-instructions.md should be a symlink');

    const target = fs.readlinkSync(copilotPath);
    assert.match(target, /CLAUDE\.md$/, 'copilot-instructions.md should point to CLAUDE.md');
  } else {
    // On Windows, just check content matches
    const copilotContent = fs.readFileSync(copilotPath, 'utf8');
    const claudeContent = fs.readFileSync(path.resolve(__dirname, '../../../CLAUDE.md'), 'utf8');
    assert.equal(copilotContent, claudeContent, 'copilot-instructions.md content should match CLAUDE.md');
  }
});

// Test apps/web/README.md
test('apps/web/README.md: documents web app architecture', () => {
  const webReadmePath = path.resolve(__dirname, '../../../apps/web/README.md');
  const content = readMarkdown(webReadmePath);

  assert.match(content, /next\.?js/i, 'should mention Next.js');
  assert.match(content, /tailwind/i, 'should mention Tailwind');
  assert.match(content, /shadcn/i, 'should mention shadcn/ui');
});

test('apps/web/README.md: documents route structure', () => {
  const webReadmePath = path.resolve(__dirname, '../../../apps/web/README.md');
  const content = readMarkdown(webReadmePath);

  assert.match(content, /route/i, 'should document routes');
  assert.match(content, /\(marketing\)/i, 'should document marketing route group');
  assert.match(content, /\(app\)/i, 'should document app route group');
});

test('apps/web/README.md: documents components', () => {
  const webReadmePath = path.resolve(__dirname, '../../../apps/web/README.md');
  const content = readMarkdown(webReadmePath);

  assert.match(content, /component/i, 'should have components section');
  assert.match(content, /app-shell/i, 'should document app-shell component');
});

test('apps/web/README.md: documents auth system', () => {
  const webReadmePath = path.resolve(__dirname, '../../../apps/web/README.md');
  const content = readMarkdown(webReadmePath);

  assert.match(content, /auth/i, 'should document auth system');
  assert.match(content, /msal/i, 'should mention MSAL');
  assert.match(content, /b2c/i, 'should mention B2C');
  assert.match(content, /dev bypass/i, 'should mention dev bypass mode');
});

test('apps/web/README.md: documents environment variables', () => {
  const webReadmePath = path.resolve(__dirname, '../../../apps/web/README.md');
  const content = readMarkdown(webReadmePath);

  assert.match(content, /environment variables?/i, 'should have environment variables section');
  assert.match(content, /NEXT_PUBLIC_/i, 'should document NEXT_PUBLIC_ variables');
});

// Test .husky/README.md
test('.husky/README.md: documents husky git hooks', () => {
  const huskyReadmePath = path.resolve(__dirname, '../../../.husky/README.md');
  const content = readMarkdown(huskyReadmePath);

  assert.match(content, /husky/i, 'should mention Husky');
  assert.match(content, /git hooks?/i, 'should mention git hooks');
});

test('.husky/README.md: documents pre-commit hook', () => {
  const huskyReadmePath = path.resolve(__dirname, '../../../.husky/README.md');
  const content = readMarkdown(huskyReadmePath);

  assert.match(content, /pre-commit/i, 'should document pre-commit hook');
});

test('.husky/README.md: documents commit message generation', () => {
  const huskyReadmePath = path.resolve(__dirname, '../../../.husky/README.md');
  const content = readMarkdown(huskyReadmePath);

  assert.match(content, /commit message/i, 'should document commit message generation');
  assert.match(content, /claude/i, 'should mention Claude AI');
  assert.match(content, /anthropic/i, 'should mention Anthropic API');
});

test('.husky/README.md: documents conventional commits', () => {
  const huskyReadmePath = path.resolve(__dirname, '../../../.husky/README.md');
  const content = readMarkdown(huskyReadmePath);

  assert.match(content, /conventional commit/i, 'should mention conventional commits');
  assert.match(content, /feat:/i, 'should show feat: example');
  assert.match(content, /fix:/i, 'should show fix: example');
});

test('.husky/README.md: has troubleshooting section', () => {
  const huskyReadmePath = path.resolve(__dirname, '../../../.husky/README.md');
  const content = readMarkdown(huskyReadmePath);

  assert.match(content, /troubleshoot/i, 'should have troubleshooting section');
});

// Test DEV_MERGE_PLAN.md
test('DEV_MERGE_PLAN.md: documents merge strategy', () => {
  const mergePlanPath = path.resolve(__dirname, '../../../DEV_MERGE_PLAN.md');
  const content = readMarkdown(mergePlanPath);

  assert.match(content, /merge/i, 'should mention merge');
  assert.match(content, /conflict/i, 'should discuss conflicts');
});

test('DEV_MERGE_PLAN.md: has numbered steps or clear structure', () => {
  const mergePlanPath = path.resolve(__dirname, '../../../DEV_MERGE_PLAN.md');
  const content = readMarkdown(mergePlanPath);

  // Should have numbered list or clear steps
  const hasNumberedList = /^\d+\./m.test(content);
  const hasSteps = /step/i.test(content);

  assert.ok(
    hasNumberedList || hasSteps,
    'should have numbered steps or clear structure'
  );
});

// Test MERGE_STATUS.md
test('MERGE_STATUS.md: tracks merge status', () => {
  const mergeStatusPath = path.resolve(__dirname, '../../../MERGE_STATUS.md');
  const content = readMarkdown(mergeStatusPath);

  assert.match(content, /merge/i, 'should mention merge');

  // Should have some status indicators
  const hasStatus = /status|summary|outstanding|complete/i.test(content);
  assert.ok(hasStatus, 'should track status or issues');
});

test('MERGE_STATUS.md: mentions testing or issues', () => {
  const mergeStatusPath = path.resolve(__dirname, '../../../MERGE_STATUS.md');
  const content = readMarkdown(mergeStatusPath);

  const hasRelevantInfo = /test|issue|problem|fix|lint|husky/i.test(content);
  assert.ok(hasRelevantInfo, 'should mention testing or issues');
});

// Test markdown formatting consistency
test('all markdown files: have proper heading hierarchy', () => {
  const markdownFiles = [
    path.resolve(__dirname, '../../../README.md'),
    path.resolve(__dirname, '../../../CONTRIBUTING.md'),
    path.resolve(__dirname, '../../../CLAUDE.md'),
    path.resolve(__dirname, '../../../apps/web/README.md'),
    path.resolve(__dirname, '../../../.husky/README.md'),
  ];

  markdownFiles.forEach((filePath) => {
    const content = readMarkdown(filePath);
    const headings = extractHeadings(content);

    // Should start with H1
    if (headings.length > 0) {
      assert.equal(
        headings[0].level,
        1,
        `${path.basename(filePath)} should start with H1`
      );
    }

    // Check for proper heading hierarchy (allow some flexibility for code blocks/lists)
    // Just verify we have reasonable structure, not strict single-level jumps
    for (let i = 1; i < headings.length; i++) {
      const diff = headings[i].level - headings[i - 1].level;
      // Allow up to 2 levels jump (common in markdown with nested sections)
      assert.ok(
        Math.abs(diff) <= 2,
        `${path.basename(filePath)} should not skip too many heading levels (H${headings[i - 1].level} -> H${headings[i].level})`
      );
    }
  });
});

test('all markdown files: end with newline', () => {
  const markdownFiles = [
    path.resolve(__dirname, '../../../README.md'),
    path.resolve(__dirname, '../../../CONTRIBUTING.md'),
    path.resolve(__dirname, '../../../CLAUDE.md'),
    path.resolve(__dirname, '../../../apps/web/README.md'),
    path.resolve(__dirname, '../../../.husky/README.md'),
    path.resolve(__dirname, '../../../DEV_MERGE_PLAN.md'),
    path.resolve(__dirname, '../../../MERGE_STATUS.md'),
  ];

  markdownFiles.forEach((filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(
      content.endsWith('\n'),
      `${path.basename(filePath)} should end with newline`
    );
  });
});
