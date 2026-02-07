const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const commitlintConfig = require(path.resolve(
  __dirname,
  '../../../commitlint.config.js'
));

const polishThemedRule =
  commitlintConfig.plugins?.[0]?.rules?.['polish-themed-message'];

test('polish-themed-message: validates commit subjects with polish-themed words', () => {
  assert.equal(typeof polishThemedRule, 'function');

  const [valid] = polishThemedRule({
    subject: 'add glossy topcoat to swatch cards',
  });

  assert.equal(valid, true);
});

test('polish-themed-message: rejects commit subjects without polish-themed words', () => {
  assert.equal(typeof polishThemedRule, 'function');

  const [valid, message] = polishThemedRule({
    subject: 'add new detail view',
  });

  assert.equal(valid, false);
  assert.match(message, /nail polish themes/i);
});
