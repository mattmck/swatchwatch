const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('next.config.ts exports valid configuration', async () => {
  // TypeScript files need to be compiled or imported via a loader
  // For this test, we'll read and validate the structure
  const fs = require('node:fs/promises');
  const configPath = path.resolve(__dirname, '../next.config.ts');
  const content = await fs.readFile(configPath, 'utf8');

  // Validate that the file contains the expected configuration
  assert.match(content, /output:\s*"export"/, 'Should configure static export output');
  assert.match(content, /trailingSlash:\s*true/, 'Should enable trailing slashes for Azure Static Web Apps');
  assert.match(content, /export default nextConfig/, 'Should export the configuration');
  assert.match(content, /import.*NextConfig/, 'Should import NextConfig type');
});

test('next.config.ts structure is valid for Azure Static Web Apps', async () => {
  const fs = require('node:fs/promises');
  const configPath = path.resolve(__dirname, '../next.config.ts');
  const content = await fs.readFile(configPath, 'utf8');

  // Azure Static Web Apps requires static export
  assert.match(content, /output:\s*"export"/, 'Must use static export for Azure SWA deployment');

  // Verify comment explains the requirement
  assert.match(content, /Azure Static Web Apps/, 'Should document Azure SWA requirement');
});