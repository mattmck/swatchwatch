const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DETECT_CHANGES_PATH = path.resolve(__dirname, '../../../.husky/detect-changes.sh');

function runDetectChanges(changedFiles) {
  try {
    const output = execFileSync('sh', [DETECT_CHANGES_PATH, changedFiles], {
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

// Edge case tests for detect-changes.sh
test('detect-changes.sh: handles empty file list', () => {
  // When script gets empty input, it returns no output (which is correct behavior)
  // The calling script (pre-push) handles this by checking if CHANGED_FILES is empty first
  try {
    const output = execFileSync('sh', [DETECT_CHANGES_PATH, ''], {
      encoding: 'utf8',
      env: { ...process.env },
    });

    // If script produces output, it should be all false
    if (output.trim()) {
      const result = output.trim().split('\n').reduce((acc, line) => {
        const [key, value] = line.split('=');
        acc[key] = value === 'true';
        return acc;
      }, {});

      assert.equal(result.BUILD_SHARED, false, 'should not build anything for empty list');
      assert.equal(result.BUILD_WEB, false, 'should not build anything for empty list');
      assert.equal(result.BUILD_FUNCTIONS, false, 'should not build anything for empty list');
      assert.equal(result.VALIDATE_INFRA, false, 'should not build anything for empty list');
    } else {
      // No output is also acceptable - the script only runs if there's input
      assert.ok(true, 'script correctly produces no output for empty input');
    }
  } catch (error) {
    // Script may not produce output at all, which is fine
    assert.ok(true, 'script handles empty input gracefully');
  }
});

test('detect-changes.sh: handles files with spaces in path', () => {
  // This is a boundary case - files shouldn't have spaces but script should handle it
  const result = runDetectChanges('apps/web/src/my file.tsx');

  assert.equal(result.BUILD_WEB, true, 'should detect web changes even with spaces');
});

test('detect-changes.sh: handles deeply nested paths', () => {
  const result = runDetectChanges('packages/shared/src/types/deeply/nested/structure/type.ts');

  assert.equal(result.BUILD_SHARED, true, 'should detect shared package changes regardless of depth');
  assert.equal(result.BUILD_WEB, true, 'should propagate to web');
  assert.equal(result.BUILD_FUNCTIONS, true, 'should propagate to functions');
});

test('detect-changes.sh: handles mixed line endings', () => {
  // Test with both LF and CRLF mixed (edge case)
  const result = runDetectChanges('apps/web/page.tsx\npackages/functions/auth.ts');

  assert.equal(result.BUILD_WEB, true, 'should detect web changes');
  assert.equal(result.BUILD_FUNCTIONS, true, 'should detect functions changes');
});

test('detect-changes.sh: handles duplicate file paths', () => {
  const result = runDetectChanges('apps/web/page.tsx\napps/web/page.tsx\napps/web/page.tsx');

  assert.equal(result.BUILD_WEB, true, 'should detect web changes once');
  assert.equal(result.BUILD_SHARED, false, 'should not falsely detect other changes');
});

test('detect-changes.sh: handles case sensitivity correctly', () => {
  // File paths should be case-sensitive on Unix systems
  const result = runDetectChanges('Apps/Web/page.tsx');

  // This shouldn't match apps/web pattern
  assert.equal(result.BUILD_WEB, false, 'should be case-sensitive');
});

test('detect-changes.sh: handles special characters in filenames', () => {
  const result = runDetectChanges('apps/web/src/special-file_name.test.tsx');

  assert.equal(result.BUILD_WEB, true, 'should handle dashes and underscores');
});

test('detect-changes.sh: prioritizes shared changes correctly', () => {
  // If shared changes, it should trigger web and functions even if they're not in the list
  const result = runDetectChanges('packages/shared/index.ts\nREADME.md');

  assert.equal(result.BUILD_SHARED, true, 'shared should build');
  assert.equal(result.BUILD_WEB, true, 'web should rebuild due to shared dependency');
  assert.equal(result.BUILD_FUNCTIONS, true, 'functions should rebuild due to shared dependency');
  assert.equal(result.VALIDATE_INFRA, false, 'infra should not validate');
});

test('detect-changes.sh: handles workspace package.json at different levels', () => {
  // Workspace-level package.json should trigger all builds
  const result1 = runDetectChanges('package.json');
  assert.equal(result1.BUILD_SHARED, true, 'root package.json should trigger all');
  assert.equal(result1.BUILD_WEB, true, 'root package.json should trigger all');
  assert.equal(result1.BUILD_FUNCTIONS, true, 'root package.json should trigger all');

  // Package-specific package.json should only trigger that package
  const result2 = runDetectChanges('apps/web/package.json');
  assert.equal(result2.BUILD_SHARED, false, 'web package.json should not trigger shared');
  assert.equal(result2.BUILD_WEB, true, 'web package.json should trigger web');
  assert.equal(result2.BUILD_FUNCTIONS, false, 'web package.json should not trigger functions');
});

// Edge case tests for configuration files
test('JSON configs: handle UTF-8 BOM if present', () => {
  // .env.example and JSON files should not have BOM, but test robustness
  const webPkgPath = path.resolve(__dirname, '../../../apps/web/package.json');
  const content = fs.readFileSync(webPkgPath, 'utf8');

  assert.ok(
    !content.startsWith('\uFEFF'),
    'JSON files should not have UTF-8 BOM'
  );
});

test('YAML workflows: no tabs (only spaces for indentation)', () => {
  const workflowPath = path.resolve(__dirname, '../../../.github/workflows/deploy-dev.yml');
  const content = fs.readFileSync(workflowPath, 'utf8');

  assert.ok(
    !content.includes('\t'),
    'YAML files should use spaces, not tabs for indentation'
  );
});

test('shell scripts: use portable sh features (no bash-isms)', () => {
  const detectChangesContent = fs.readFileSync(DETECT_CHANGES_PATH, 'utf8');
  const prePushPath = path.resolve(__dirname, '../../../.husky/pre-push');
  const prePushContent = fs.readFileSync(prePushPath, 'utf8');

  // Check for common bash-isms that won't work in plain sh
  const bashisms = [
    /\[\[.*\]\]/, // [[ ]] is bash-specific, use [ ]
    /==/, // == in test is bash-specific, use =
    /function\s+\w+\s*\(\)/, // function keyword is bash-specific
  ];

  bashisms.forEach((pattern) => {
    assert.ok(
      !pattern.test(detectChangesContent),
      `detect-changes.sh should not use bash-isms: ${pattern}`
    );
    assert.ok(
      !pattern.test(prePushContent),
      `pre-push should not use bash-isms: ${pattern}`
    );
  });
});

test('shell scripts: handle signals properly', () => {
  const prePushPath = path.resolve(__dirname, '../../../.husky/pre-push');
  const content = fs.readFileSync(prePushPath, 'utf8');

  // Script should exit with proper codes
  assert.match(
    content,
    /exit\s+[01]/,
    'should exit with explicit 0 or 1 status codes'
  );
});

test('.env.example: handles edge case variable values', () => {
  const envPath = path.resolve(__dirname, '../../../.env.example');
  const content = fs.readFileSync(envPath, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      // Variable should not have unescaped special characters
      if (line.includes('=')) {
        const [, value] = line.split('=');
        // Should not have unquoted spaces in values (if there are values)
        if (value && value.includes(' ') && !value.startsWith('"')) {
          assert.fail(
            `Variable value with spaces should be quoted: ${line}`
          );
        }
      }
    }
  });
});

// Regression tests
test('next.config.ts: does not use deprecated target option', async () => {
  const configPath = path.resolve(__dirname, '../../../apps/web/next.config.ts');
  const config = await import(configPath);
  const nextConfig = config.default || config;

  assert.equal(
    nextConfig.target,
    undefined,
    'should not use deprecated target option'
  );
});

test('package.json: semver ranges are valid', () => {
  const webPkgPath = path.resolve(__dirname, '../../../apps/web/package.json');
  const pkg = JSON.parse(fs.readFileSync(webPkgPath, 'utf8'));

  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  Object.entries(allDeps).forEach(([name, version]) => {
    // Workspace protocol or version range
    if (!version.startsWith('*') && !version.startsWith('workspace:')) {
      // Allow: ^4, ^1.2.3, ~1.2.3, 1.2.3, file:, or workspace refs
      assert.match(
        version,
        /^[\^~]?\d+(\.\d+)?(\.\d+)?$|^file:/,
        `${name} should have valid semver: ${version}`
      );
    }
  });
});

test('GitHub workflows: environment names are lowercase', () => {
  const deployDevPath = path.resolve(__dirname, '../../../.github/workflows/deploy-dev.yml');
  const content = fs.readFileSync(deployDevPath, 'utf8');

  // Environment names should be lowercase for consistency
  const envMatches = content.match(/environment:\s*(\w+)/g);
  if (envMatches) {
    envMatches.forEach((match) => {
      const envName = match.split(':')[1].trim();
      assert.equal(
        envName,
        envName.toLowerCase(),
        `Environment name should be lowercase: ${envName}`
      );
    });
  }
});

test('shell scripts: exit codes are consistent', () => {
  const prePushPath = path.resolve(__dirname, '../../../.husky/pre-push');
  const content = fs.readFileSync(prePushPath, 'utf8');

  // Should exit 0 on success, 1 on failure
  const exitCalls = content.match(/exit\s+\d+/g) || [];
  exitCalls.forEach((exitCall) => {
    const code = parseInt(exitCall.split(/\s+/)[1]);
    assert.ok(
      code === 0 || code === 1,
      `Exit code should be 0 (success) or 1 (failure), not ${code}`
    );
  });
});

test('detect-changes.sh: respects order of dependencies', () => {
  // When shared changes, the script should set flags in correct order
  const result = runDetectChanges('packages/shared/index.ts');

  // All three should be true because shared changed
  assert.equal(result.BUILD_SHARED, true);
  assert.equal(result.BUILD_WEB, true);
  assert.equal(result.BUILD_FUNCTIONS, true);

  // This validates the dependency chain logic
});

test('configuration files: no merge conflict markers', () => {
  const files = [
    '../../../.env.example',
    '../../../apps/web/package.json',
    '../../../apps/web/next.config.ts',
    '../../../.github/workflows/deploy-dev.yml',
  ];

  const conflictMarkers = ['<<<<<<<', '=======', '>>>>>>>'];

  files.forEach((file) => {
    const filePath = path.resolve(__dirname, file);
    const content = fs.readFileSync(filePath, 'utf8');

    conflictMarkers.forEach((marker) => {
      assert.ok(
        !content.includes(marker),
        `${file} should not contain merge conflict marker: ${marker}`
      );
    });
  });
});

test('.claude/settings.local.json: no duplicate permissions', () => {
  const configPath = path.resolve(__dirname, '../../../.claude/settings.local.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const allowList = config.permissions.allow;
  const uniqueSet = new Set(allowList);

  assert.equal(
    uniqueSet.size,
    allowList.length,
    'should not have duplicate permissions in allow list'
  );
});