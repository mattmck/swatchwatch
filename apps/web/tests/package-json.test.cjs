const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

test('package.json has valid structure', async () => {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const content = await fs.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(content);

  // Basic structure validation
  assert.ok(pkg.name, 'Should have a name');
  assert.equal(pkg.private, true, 'Web app should be private');
  assert.ok(pkg.scripts, 'Should have scripts');
  assert.ok(pkg.dependencies, 'Should have dependencies');
  assert.ok(pkg.devDependencies, 'Should have devDependencies');
});

test('package.json has required scripts', async () => {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const content = await fs.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(content);

  // Required scripts for Next.js app
  assert.equal(pkg.scripts.dev, 'next dev', 'Should have dev script');
  assert.equal(pkg.scripts.build, 'next build', 'Should have build script');
  assert.equal(pkg.scripts.start, 'next start', 'Should have start script');
  assert.equal(pkg.scripts.lint, 'eslint', 'Should have lint script');
});

test('package.json has required Next.js dependencies', async () => {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const content = await fs.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(content);

  // Core Next.js dependencies
  assert.ok(pkg.dependencies.next, 'Should have next dependency');
  assert.ok(pkg.dependencies.react, 'Should have react dependency');
  assert.ok(pkg.dependencies['react-dom'], 'Should have react-dom dependency');
});

test('package.json has required auth dependencies', async () => {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const content = await fs.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(content);

  // Azure AD B2C / MSAL dependencies
  assert.ok(pkg.dependencies['@azure/msal-browser'], 'Should have @azure/msal-browser for auth');
  assert.ok(pkg.dependencies['@azure/msal-react'], 'Should have @azure/msal-react for React integration');
});

test('package.json has required UI dependencies', async () => {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const content = await fs.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(content);

  // shadcn/ui and Tailwind ecosystem
  assert.ok(pkg.dependencies['lucide-react'], 'Should have lucide-react for icons');
  assert.ok(pkg.dependencies['class-variance-authority'], 'Should have cva for shadcn components');
  assert.ok(pkg.dependencies.clsx, 'Should have clsx for class merging');
  assert.ok(pkg.dependencies['tailwind-merge'], 'Should have tailwind-merge');
  assert.ok(pkg.dependencies.sonner, 'Should have sonner for toasts');
});

test('package.json has shared types dependency', async () => {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const content = await fs.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(content);

  assert.ok(pkg.dependencies['swatchwatch-shared'], 'Should have swatchwatch-shared workspace dependency');
});

test('package.json versions match expected patterns', async () => {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const content = await fs.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(content);

  // Next.js version should be specific
  assert.match(pkg.dependencies.next, /^\d+\.\d+\.\d+$/, 'Next.js version should be pinned (no ^ or ~)');

  // React versions should match each other
  const reactVersion = pkg.dependencies.react;
  assert.equal(pkg.dependencies['react-dom'], reactVersion, 'react-dom version should match react version');
});