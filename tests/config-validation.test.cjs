const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

test('.claude/settings.local.json has valid structure', async () => {
  const settingsPath = path.resolve(__dirname, '../.claude/settings.local.json');
  const content = await fs.readFile(settingsPath, 'utf8');
  const settings = JSON.parse(content);

  assert.ok(settings.permissions, 'Should have permissions object');
  assert.ok(Array.isArray(settings.permissions.allow), 'Should have allow array');
});

test('.claude/settings.local.json permissions are valid', async () => {
  const settingsPath = path.resolve(__dirname, '../.claude/settings.local.json');
  const content = await fs.readFile(settingsPath, 'utf8');
  const settings = JSON.parse(content);

  const validPatterns = [
    /^WebFetch\(domain:[^)]+\)$/,
    /^Bash\([^)]+\)$/,
  ];

  for (const permission of settings.permissions.allow) {
    const isValid = validPatterns.some(pattern => pattern.test(permission));
    assert.ok(isValid, `Permission "${permission}" should match a valid pattern`);
  }
});

test('.env.example has required environment variables', async () => {
  const envPath = path.resolve(__dirname, '../.env.example');
  const content = await fs.readFile(envPath, 'utf8');

  // Check for critical environment variables
  assert.match(content, /DATABASE_URL=/, 'Should define DATABASE_URL');
  assert.match(content, /NEXT_PUBLIC_AUTH_DEV_BYPASS=/, 'Should define NEXT_PUBLIC_AUTH_DEV_BYPASS');
  assert.match(content, /NEXT_PUBLIC_B2C_TENANT=/, 'Should define NEXT_PUBLIC_B2C_TENANT');
  assert.match(content, /NEXT_PUBLIC_B2C_CLIENT_ID=/, 'Should define NEXT_PUBLIC_B2C_CLIENT_ID');
});

test('.env.example has helpful comments', async () => {
  const envPath = path.resolve(__dirname, '../.env.example');
  const content = await fs.readFile(envPath, 'utf8');

  // Should have comments explaining the variables
  assert.match(content, /#.*development/, 'Should have comments about development usage');
  assert.match(content, /#.*bypass/, 'Should explain dev bypass mode');
});

test('.env.example DATABASE_URL format is valid', async () => {
  const envPath = path.resolve(__dirname, '../.env.example');
  const content = await fs.readFile(envPath, 'utf8');

  // Extract DATABASE_URL value
  const match = content.match(/DATABASE_URL=(.+)/);
  assert.ok(match, 'Should have DATABASE_URL');

  const dbUrl = match[1].trim();
  assert.match(dbUrl, /^postgres:\/\//, 'DATABASE_URL should be a PostgreSQL connection string');
  assert.match(dbUrl, /@localhost:/, 'DATABASE_URL should point to localhost for development');
});

test('root package.json workspace configuration is correct', async () => {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const content = await fs.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(content);

  assert.ok(pkg.private, 'Root package should be private');
  assert.ok(Array.isArray(pkg.workspaces), 'Should have workspaces array');
  assert.ok(pkg.workspaces.includes('apps/*'), 'Should include apps/* workspace');
  assert.ok(pkg.workspaces.includes('packages/*'), 'Should include packages/* workspace');
});

test('root package.json has required workspace scripts', async () => {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const content = await fs.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(content);

  const requiredScripts = [
    'setup',
    'dev',
    'dev:web',
    'dev:functions',
    'dev:shared',
    'build',
    'build:shared',
    'build:web',
    'build:functions',
    'lint',
    'typecheck',
    'test',
  ];

  for (const script of requiredScripts) {
    assert.ok(pkg.scripts[script], `Should have ${script} script`);
  }
});

test('root package.json has Husky prepare hook', async () => {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const content = await fs.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(content);

  assert.equal(pkg.scripts.prepare, 'husky', 'Should have Husky prepare hook');
  assert.ok(pkg.devDependencies.husky, 'Should have husky as devDependency');
});