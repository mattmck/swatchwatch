const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const NEXT_CONFIG_PATH = path.resolve(__dirname, '../../../apps/web/next.config.ts');

// Dynamic import helper for ESM modules
async function importNextConfig() {
  // Use dynamic import to load the TypeScript/ESM config
  // This requires the config to be transpiled or we read it as text
  const module = await import(NEXT_CONFIG_PATH);
  return module.default || module;
}

test('next.config.ts: exports a valid Next.js configuration', async () => {
  const config = await importNextConfig();

  assert.ok(config !== null && config !== undefined, 'config should be exported');
  assert.equal(typeof config, 'object', 'config should be an object');
});

test('next.config.ts: enables static export for Azure Static Web Apps', async () => {
  const config = await importNextConfig();

  assert.equal(
    config.output,
    'export',
    'output should be set to "export" for static export'
  );
});

test('next.config.ts: enables trailing slash for static routes', async () => {
  const config = await importNextConfig();

  assert.equal(
    config.trailingSlash,
    true,
    'trailingSlash should be true for Azure Static Web Apps'
  );
});

test('next.config.ts: has correct TypeScript typing', async () => {
  const fs = require('node:fs');
  const content = fs.readFileSync(NEXT_CONFIG_PATH, 'utf8');

  assert.match(
    content,
    /import\s+type\s+{\s*NextConfig\s*}\s+from\s+["']next["']/,
    'should import NextConfig type from next'
  );

  assert.match(
    content,
    /const\s+nextConfig:\s*NextConfig/,
    'should type nextConfig variable with NextConfig'
  );
});

test('next.config.ts: exports default configuration', async () => {
  const fs = require('node:fs');
  const content = fs.readFileSync(NEXT_CONFIG_PATH, 'utf8');

  assert.match(
    content,
    /export\s+default\s+nextConfig/,
    'should export default nextConfig'
  );
});

test('next.config.ts: static export configuration is compatible with Azure', async () => {
  const config = await importNextConfig();

  // Azure Static Web Apps requires static artifacts
  assert.equal(config.output, 'export', 'must use static export');
  assert.equal(config.trailingSlash, true, 'must have trailing slashes');

  // Should not have server-side features that conflict with static export
  assert.equal(
    config.serverRuntimeConfig,
    undefined,
    'should not use server runtime config with static export'
  );
  assert.equal(
    config.rewrites,
    undefined,
    'should not use rewrites with static export (use Azure staticwebapp.config.json instead)'
  );
});

test('next.config.ts: minimal configuration (no unnecessary options)', async () => {
  const config = await importNextConfig();

  const keys = Object.keys(config);

  // Should only have the essential options for Azure deployment
  assert.ok(keys.includes('output'), 'should have output option');
  assert.ok(keys.includes('trailingSlash'), 'should have trailingSlash option');

  // Should not have experimental or deprecated options unless needed
  const unnecessaryOptions = [
    'amp',
    'analyticsId',
    'generateBuildId',
    'generateEtags',
    'onDemandEntries',
    'pageExtensions',
    'poweredByHeader',
    'publicRuntimeConfig',
    'serverRuntimeConfig',
    'target', // deprecated
    'useFileSystemPublicRoutes',
  ];

  unnecessaryOptions.forEach((option) => {
    assert.equal(
      config[option],
      undefined,
      `should not have unnecessary option: ${option}`
    );
  });
});

test('next.config.ts: file structure is clean and readable', async () => {
  const fs = require('node:fs');
  const content = fs.readFileSync(NEXT_CONFIG_PATH, 'utf8');

  // Should be a small, focused config file
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  assert.ok(
    lines.length < 20,
    'config file should be concise (< 20 non-empty lines)'
  );

  // Should have comments explaining Azure requirements
  assert.match(
    content,
    /Azure Static Web Apps/i,
    'should have comment explaining Azure deployment'
  );
});