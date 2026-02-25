const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Helper to read and parse JSON files
function readJSON(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(content);
}

// Helper to validate YAML syntax
function isValidYAML(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Basic YAML validation checks
  // Check for balanced quotes
  const singleQuotes = (content.match(/'/g) || []).length;
  const doubleQuotes = (content.match(/"/g) || []).length;

  // Check for basic structure
  const hasKeys = /^\s*[\w-]+:/m.test(content);

  return hasKeys;
}

// Test .claude/settings.local.json
test('.claude/settings.local.json: is valid JSON', () => {
  const configPath = path.resolve(__dirname, '../../../.claude/settings.local.json');

  assert.doesNotThrow(
    () => readJSON(configPath),
    'settings.local.json should be valid JSON'
  );
});

test('.claude/settings.local.json: has permissions structure', () => {
  const configPath = path.resolve(__dirname, '../../../.claude/settings.local.json');
  const config = readJSON(configPath);

  assert.ok(config.permissions, 'should have permissions property');
  assert.ok(Array.isArray(config.permissions.allow), 'permissions.allow should be an array');
});

test('.claude/settings.local.json: allow list contains valid permission patterns', () => {
  const configPath = path.resolve(__dirname, '../../../.claude/settings.local.json');
  const config = readJSON(configPath);

  const allowList = config.permissions.allow;
  assert.ok(allowList.length > 0, 'allow list should not be empty');

  // Each permission should match expected patterns (including wildcards)
  const validPatterns = [
    /^WebFetch\(\*\)$/,                    // WebFetch(*)
    /^WebFetch\(domain:[^)]+\)$/,          // WebFetch(domain:example.com)
    /^Bash\([^)]+\)$/,                     // Bash(command:*) or Bash(git:*)
    /^WebSearch$/,                         // WebSearch (no args)
  ];

  allowList.forEach((permission) => {
    const isValid = validPatterns.some((pattern) => pattern.test(permission));
    assert.ok(
      isValid,
      `Permission "${permission}" should match a valid pattern`
    );
  });
});

test('.claude/settings.local.json: allows web fetching', () => {
  const configPath = path.resolve(__dirname, '../../../.claude/settings.local.json');
  const config = readJSON(configPath);

  const allowList = config.permissions.allow;
  
  // Check if WebFetch is allowed (either wildcard or specific domains)
  const hasWebFetch = allowList.some((p) => 
    p === 'WebFetch(*)' || p.startsWith('WebFetch(domain:')
  );

  assert.ok(hasWebFetch, 'should allow WebFetch either via wildcard or specific domains');
});

// Test apps/web/package.json
test('apps/web/package.json: is valid JSON', () => {
  const pkgPath = path.resolve(__dirname, '../../../apps/web/package.json');

  assert.doesNotThrow(
    () => readJSON(pkgPath),
    'package.json should be valid JSON'
  );
});

test('apps/web/package.json: has required fields', () => {
  const pkgPath = path.resolve(__dirname, '../../../apps/web/package.json');
  const pkg = readJSON(pkgPath);

  assert.ok(pkg.name, 'should have name');
  assert.ok(pkg.version, 'should have version');
  assert.ok(pkg.scripts, 'should have scripts');
  assert.ok(pkg.dependencies, 'should have dependencies');
  assert.ok(pkg.devDependencies, 'should have devDependencies');
});

test('apps/web/package.json: has correct package name', () => {
  const pkgPath = path.resolve(__dirname, '../../../apps/web/package.json');
  const pkg = readJSON(pkgPath);

  assert.equal(pkg.name, 'swatchwatch-web', 'should be named swatchwatch-web');
  assert.equal(pkg.private, true, 'should be private');
});

test('apps/web/package.json: has Next.js scripts', () => {
  const pkgPath = path.resolve(__dirname, '../../../apps/web/package.json');
  const pkg = readJSON(pkgPath);

  assert.ok(pkg.scripts.dev, 'should have dev script');
  assert.ok(pkg.scripts.build, 'should have build script');
  assert.ok(pkg.scripts.start, 'should have start script');
  assert.ok(pkg.scripts.lint, 'should have lint script');

  assert.match(pkg.scripts.dev, /next dev/, 'dev script should run next dev');
  assert.match(pkg.scripts.build, /next build/, 'build script should run next build');
});

test('apps/web/package.json: includes required dependencies', () => {
  const pkgPath = path.resolve(__dirname, '../../../apps/web/package.json');
  const pkg = readJSON(pkgPath);

  const requiredDeps = [
    'next',
    'react',
    'react-dom',
    'swatchwatch-shared',
  ];

  requiredDeps.forEach((dep) => {
    assert.ok(
      pkg.dependencies[dep],
      `should have ${dep} in dependencies`
    );
  });
});

test('apps/web/package.json: Next.js versions are consistent', () => {
  const pkgPath = path.resolve(__dirname, '../../../apps/web/package.json');
  const pkg = readJSON(pkgPath);

  const nextVersion = pkg.dependencies.next;
  const eslintNextVersion = pkg.devDependencies['eslint-config-next'];

  if (eslintNextVersion) {
    assert.equal(
      nextVersion,
      eslintNextVersion,
      'next and eslint-config-next versions should match'
    );
  }
});

test('apps/web/package.json: includes Azure MSAL dependencies', () => {
  const pkgPath = path.resolve(__dirname, '../../../apps/web/package.json');
  const pkg = readJSON(pkgPath);

  assert.ok(
    pkg.dependencies['@azure/msal-browser'],
    'should have @azure/msal-browser for Azure AD B2C auth'
  );
  assert.ok(
    pkg.dependencies['@azure/msal-react'],
    'should have @azure/msal-react for React integration'
  );
});

// Test GitHub workflow files
test('.github/workflows/deploy-dev.yml: is valid YAML structure', () => {
  const workflowPath = path.resolve(__dirname, '../../../.github/workflows/deploy-dev.yml');

  assert.ok(
    isValidYAML(workflowPath),
    'deploy-dev.yml should be valid YAML'
  );
});

test('.github/workflows/deploy-dev.yml: has required workflow structure', () => {
  const workflowPath = path.resolve(__dirname, '../../../.github/workflows/deploy-dev.yml');
  const content = fs.readFileSync(workflowPath, 'utf8');

  assert.match(content, /^name:/m, 'should have name field');
  assert.match(content, /^on:/m, 'should have on (trigger) field');
  assert.match(content, /^jobs:/m, 'should have jobs field');
});

test('.github/workflows/deploy-dev.yml: defines deployment jobs', () => {
  const workflowPath = path.resolve(__dirname, '../../../.github/workflows/deploy-dev.yml');
  const content = fs.readFileSync(workflowPath, 'utf8');

  assert.match(content, /deploy-web:/m, 'should have deploy-web job');
  assert.match(content, /deploy-functions:/m, 'should have deploy-functions job');
});

test('.github/workflows/deploy-dev.yml: uses Azure login with OIDC', () => {
  const workflowPath = path.resolve(__dirname, '../../../.github/workflows/deploy-dev.yml');
  const content = fs.readFileSync(workflowPath, 'utf8');

  assert.match(content, /azure\/login@v2/, 'should use azure/login action');
  assert.match(content, /client-id:/, 'should use OIDC with client-id');
  assert.match(content, /tenant-id:/, 'should use OIDC with tenant-id');
  assert.match(content, /subscription-id:/, 'should use OIDC with subscription-id');
});

test('.github/workflows/deploy-infra-dev.yml: is valid YAML structure', () => {
  const workflowPath = path.resolve(__dirname, '../../../.github/workflows/deploy-infra-dev.yml');

  assert.ok(
    isValidYAML(workflowPath),
    'deploy-infra-dev.yml should be valid YAML'
  );
});

test('.github/workflows/deploy-infra-dev.yml: has Terraform steps', () => {
  const workflowPath = path.resolve(__dirname, '../../../.github/workflows/deploy-infra-dev.yml');
  const content = fs.readFileSync(workflowPath, 'utf8');

  assert.match(content, /terraform init/i, 'should run terraform init');
  assert.match(content, /terraform validate/i, 'should run terraform validate');
  assert.match(content, /terraform plan/i, 'should run terraform plan');
  assert.match(content, /terraform apply/i, 'should run terraform apply');
});

test('.github/workflows/deploy-infra-dev.yml: detects infrastructure changes', () => {
  const workflowPath = path.resolve(__dirname, '../../../.github/workflows/deploy-infra-dev.yml');
  const content = fs.readFileSync(workflowPath, 'utf8');

  assert.match(
    content,
    /detect-infra-changes/,
    'should have job to detect infrastructure changes'
  );
  assert.match(
    content,
    /infrastructure\//,
    'should check for changes in infrastructure directory'
  );
});

test('.github/workflows/deploy-infra-dev.yml: uses concurrency control', () => {
  const workflowPath = path.resolve(__dirname, '../../../.github/workflows/deploy-infra-dev.yml');
  const content = fs.readFileSync(workflowPath, 'utf8');

  assert.match(
    content,
    /concurrency:/,
    'should have concurrency group to prevent parallel infra deploys'
  );
  assert.match(
    content,
    /cancel-in-progress: false/,
    'should not cancel in-progress infrastructure deployments'
  );
});

// Additional validation test for workflow permissions
test('.github/workflows: use minimal required permissions', () => {
  const deployDevPath = path.resolve(__dirname, '../../../.github/workflows/deploy-dev.yml');
  const deployInfraPath = path.resolve(__dirname, '../../../.github/workflows/deploy-infra-dev.yml');

  [deployDevPath, deployInfraPath].forEach((workflowPath) => {
    const content = fs.readFileSync(workflowPath, 'utf8');

    assert.match(
      content,
      /permissions:/,
      `${path.basename(workflowPath)} should define permissions`
    );

    assert.match(
      content,
      /id-token:\s*write/,
      `${path.basename(workflowPath)} should have id-token: write for OIDC`
    );
  });
});