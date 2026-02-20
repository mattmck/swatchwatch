const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Helper to validate SVG XML structure
function isValidSVG(content) {
  // Basic SVG validation
  const hasSvgTag = /<svg[\s>]/.test(content);
  const hasClosingSvgTag = /<\/svg>/.test(content);
  const hasViewBox = /viewBox=/.test(content);
  const hasWidth = /\bwidth\s*=\s*["'][0-9.]+(?:px|em|rem|%|pt|pc|cm|mm|in)?["']/i.test(content);
  const hasHeight = /\bheight\s*=\s*["'][0-9.]+(?:px|em|rem|%|pt|pc|cm|mm|in)?["']/i.test(content);

  return hasSvgTag && hasClosingSvgTag && (hasViewBox || (hasWidth && hasHeight));
}

// Helper to extract SVG attributes
function getSVGAttributes(content) {
  const svgMatch = content.match(/<svg([^>]+)>/);
  if (!svgMatch) return {};

  const attrs = {};
  const attrRegex = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;

  while ((match = attrRegex.exec(svgMatch[1])) !== null) {
    attrs[match[1]] = match[2] ?? match[3] ?? '';
  }

  return attrs;
}

// Test apple-touch-icon.png
test('apple-touch-icon.png: file exists', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/apple-touch-icon.png');
  assert.ok(fs.existsSync(iconPath), 'apple-touch-icon.png should exist');
});

test('apple-touch-icon.png: is a valid PNG file', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/apple-touch-icon.png');
  const buffer = fs.readFileSync(iconPath);

  // PNG magic number: 89 50 4E 47 0D 0A 1A 0A
  assert.equal(buffer[0], 0x89, 'should have PNG magic number');
  assert.equal(buffer[1], 0x50, 'should have PNG magic number');
  assert.equal(buffer[2], 0x4e, 'should have PNG magic number');
  assert.equal(buffer[3], 0x47, 'should have PNG magic number');
});

test('apple-touch-icon.png: has reasonable file size', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/apple-touch-icon.png');
  const stats = fs.statSync(iconPath);

  // Should be between 1KB and 500KB
  assert.ok(stats.size > 1000, 'icon should be > 1KB');
  assert.ok(stats.size < 500000, 'icon should be < 500KB for performance');
});

// Test swatchwatch-app-icon.svg
test('swatchwatch-app-icon.svg: file exists', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-app-icon.svg');
  assert.ok(fs.existsSync(iconPath), 'swatchwatch-app-icon.svg should exist');
});

test('swatchwatch-app-icon.svg: is valid SVG', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-app-icon.svg');
  const content = fs.readFileSync(iconPath, 'utf8');

  assert.ok(isValidSVG(content), 'should be valid SVG');
});

test('swatchwatch-app-icon.svg: has correct dimensions', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-app-icon.svg');
  const content = fs.readFileSync(iconPath, 'utf8');
  const attrs = getSVGAttributes(content);

  assert.ok(attrs.width, 'should have width attribute');
  assert.ok(attrs.height, 'should have height attribute');
  assert.equal(attrs.width, attrs.height, 'should be square (width === height)');
});

test('swatchwatch-app-icon.svg: uses brand colors', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-app-icon.svg');
  const content = fs.readFileSync(iconPath, 'utf8');

  // Should use brand purple and pink colors
  const hasPurple = /#42107e/i.test(content) || /#7b2eff/i.test(content);
  const hasPink = /#ff4fb8/i.test(content);

  assert.ok(hasPurple, 'should use brand purple color');
  assert.ok(hasPink, 'should use brand pink color');
});

// Test swatchwatch-brush-icon.svg
test('swatchwatch-brush-icon.svg: file exists', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-brush-icon.svg');
  assert.ok(fs.existsSync(iconPath), 'swatchwatch-brush-icon.svg should exist');
});

test('swatchwatch-brush-icon.svg: is valid SVG', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-brush-icon.svg');
  const content = fs.readFileSync(iconPath, 'utf8');

  assert.ok(isValidSVG(content), 'should be valid SVG');
});

test('swatchwatch-brush-icon.svg: has square viewBox', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-brush-icon.svg');
  const content = fs.readFileSync(iconPath, 'utf8');
  const attrs = getSVGAttributes(content);

  if (attrs.viewBox) {
    const [x, y, width, height] = attrs.viewBox.split(' ').map(Number);
    assert.equal(width, height, 'viewBox should be square');
  }
});

// Test swatchwatch-lockup.svg
test('swatchwatch-lockup.svg: file exists', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-lockup.svg');
  assert.ok(fs.existsSync(iconPath), 'swatchwatch-lockup.svg should exist');
});

test('swatchwatch-lockup.svg: is valid SVG', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-lockup.svg');
  const content = fs.readFileSync(iconPath, 'utf8');

  assert.ok(isValidSVG(content), 'should be valid SVG');
});

test('swatchwatch-lockup.svg: is horizontal (wider than tall)', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-lockup.svg');
  const content = fs.readFileSync(iconPath, 'utf8');
  const attrs = getSVGAttributes(content);

  if (attrs.viewBox) {
    const [x, y, width, height] = attrs.viewBox.split(' ').map(Number);
    assert.ok(width > height, 'lockup should be horizontal (wider than tall)');
  } else if (attrs.width && attrs.height) {
    const width = parseInt(attrs.width, 10);
    const height = parseInt(attrs.height, 10);
    assert.ok(width > height, 'lockup should be horizontal (wider than tall)');
  }
});

test('swatchwatch-lockup.svg: contains text (wordmark)', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-lockup.svg');
  const content = fs.readFileSync(iconPath, 'utf8');

  // Should contain text element with "SwatchWatch" or split into "Swatch" and "Watch"
  const hasText = /<text[\s>]/.test(content);
  const hasSwatchWatch = /swatch.*watch/i.test(content);

  assert.ok(hasText && hasSwatchWatch, 'lockup should contain SwatchWatch text');
});

// Test swatchwatch-monogram.svg
test('swatchwatch-monogram.svg: file exists', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-monogram.svg');
  assert.ok(fs.existsSync(iconPath), 'swatchwatch-monogram.svg should exist');
});

test('swatchwatch-monogram.svg: is valid SVG', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-monogram.svg');
  const content = fs.readFileSync(iconPath, 'utf8');

  assert.ok(isValidSVG(content), 'should be valid SVG');
});

test('swatchwatch-monogram.svg: is square', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-monogram.svg');
  const content = fs.readFileSync(iconPath, 'utf8');
  const attrs = getSVGAttributes(content);

  if (attrs.viewBox) {
    const [x, y, width, height] = attrs.viewBox.split(' ').map(Number);
    assert.equal(width, height, 'monogram should be square');
  } else if (attrs.width && attrs.height) {
    assert.equal(attrs.width, attrs.height, 'monogram should be square');
  }
});

test('swatchwatch-monogram.svg: uses brand colors', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-monogram.svg');
  const content = fs.readFileSync(iconPath, 'utf8');

  // Should use brand colors
  const hasBrandColor = /#42107e/i.test(content) || /#7b2eff/i.test(content) || /#ff4fb8/i.test(content);

  assert.ok(hasBrandColor, 'should use brand colors');
});

// Test swatchwatch-sprite.svg
test('swatchwatch-sprite.svg: file exists', () => {
  const spritePath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-sprite.svg');
  assert.ok(fs.existsSync(spritePath), 'swatchwatch-sprite.svg should exist');
});

test('swatchwatch-sprite.svg: is valid SVG', () => {
  const spritePath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-sprite.svg');
  const content = fs.readFileSync(spritePath, 'utf8');

  assert.ok(isValidSVG(content), 'should be valid SVG');
});

test('swatchwatch-sprite.svg: contains symbol definitions', () => {
  const spritePath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-sprite.svg');
  const content = fs.readFileSync(spritePath, 'utf8');

  assert.match(content, /<symbol/i, 'sprite should contain <symbol> elements');
});

test('swatchwatch-sprite.svg: contains multiple icon symbols', () => {
  const spritePath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-sprite.svg');
  const content = fs.readFileSync(spritePath, 'utf8');

  // Should have multiple symbols
  const symbolMatches = content.match(/<symbol/gi);
  assert.ok(symbolMatches && symbolMatches.length >= 3, 'sprite should have at least 3 symbols');
});

test('swatchwatch-sprite.svg: symbols have IDs', () => {
  const spritePath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-sprite.svg');
  const content = fs.readFileSync(spritePath, 'utf8');

  // Each symbol should have an id attribute
  const symbolRegex = /<symbol([^>]+)>/gi;
  let match;
  let symbolCount = 0;
  let symbolsWithId = 0;

  while ((match = symbolRegex.exec(content)) !== null) {
    symbolCount++;
    if (/id\s*=\s*(["'])([^"']+)\1/.test(match[1])) {
      symbolsWithId++;
    }
  }

  assert.ok(symbolCount > 0, 'should have symbols');
  assert.equal(symbolCount, symbolsWithId, 'all symbols should have id attributes');
});

test('swatchwatch-sprite.svg: contains expected icon IDs', () => {
  const spritePath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-sprite.svg');
  const content = fs.readFileSync(spritePath, 'utf8');

  // Should have common icon symbols
  const expectedSymbols = [
    'swatchwatch-icon-monogram',
    'swatchwatch-icon-app',
  ];

  expectedSymbols.forEach((symbolId) => {
    const escapedSymbolId = symbolId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      content,
      new RegExp(`id\\s*=\\s*(["'])${escapedSymbolId}\\1`),
      `sprite should contain symbol with id="${symbolId}"`
    );
  });
});

// Test swatchwatch-swatch-icon-1024.png
test('swatchwatch-swatch-icon-1024.png: file exists', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-swatch-icon-1024.png');
  assert.ok(fs.existsSync(iconPath), 'swatchwatch-swatch-icon-1024.png should exist');
});

test('swatchwatch-swatch-icon-1024.png: is a valid PNG file', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-swatch-icon-1024.png');
  const buffer = fs.readFileSync(iconPath);

  // PNG magic number
  assert.equal(buffer[0], 0x89, 'should have PNG magic number');
  assert.equal(buffer[1], 0x50, 'should have PNG magic number');
  assert.equal(buffer[2], 0x4e, 'should have PNG magic number');
  assert.equal(buffer[3], 0x47, 'should have PNG magic number');
});

test('swatchwatch-swatch-icon-1024.png: has reasonable file size for 1024px icon', () => {
  const iconPath = path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-swatch-icon-1024.png');
  const stats = fs.statSync(iconPath);

  // 1024px icon should be between 10KB and 1MB
  assert.ok(stats.size > 10000, 'icon should be > 10KB');
  assert.ok(stats.size < 1000000, 'icon should be < 1MB for reasonable file size');
});

// Test consistency across brand assets
test('brand assets: all SVG files are well-formed XML', () => {
  const svgFiles = [
    path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-app-icon.svg'),
    path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-brush-icon.svg'),
    path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-lockup.svg'),
    path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-monogram.svg'),
    path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-sprite.svg'),
  ];

  svgFiles.forEach((filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');

    // Should not have unmatched tags
    const openTags = (content.match(/<[a-z]+[\s>]/gi) || []).length;
    const closeTags = (content.match(/<\/[a-z]+>/gi) || []).length;
    const selfClosingTags = (content.match(/\/>/g) || []).length;

    // Total opening tags should roughly match closing + self-closing
    // (rough check, not perfect but catches major issues)
    const fileName = path.basename(filePath);
    assert.ok(
      Math.abs(openTags - (closeTags + selfClosingTags)) <= 5,
      `${fileName} should have balanced tags`
    );
  });
});

test('brand assets: SVG files use consistent naming convention', () => {
  const svgFiles = [
    'swatchwatch-app-icon.svg',
    'swatchwatch-brush-icon.svg',
    'swatchwatch-lockup.svg',
    'swatchwatch-monogram.svg',
    'swatchwatch-sprite.svg',
  ];

  svgFiles.forEach((fileName) => {
    assert.match(
      fileName,
      /^swatchwatch-[a-z-]+\.svg$/,
      `${fileName} should follow naming convention: swatchwatch-*.svg`
    );
  });
});

test('brand assets: all required brand assets exist', () => {
  const requiredAssets = [
    '../../../apps/web/public/apple-touch-icon.png',
    '../../../apps/web/public/brand/swatchwatch-app-icon.svg',
    '../../../apps/web/public/brand/swatchwatch-brush-icon.svg',
    '../../../apps/web/public/brand/swatchwatch-lockup.svg',
    '../../../apps/web/public/brand/swatchwatch-monogram.svg',
    '../../../apps/web/public/brand/swatchwatch-sprite.svg',
    '../../../apps/web/public/brand/swatchwatch-swatch-icon-1024.png',
  ];

  requiredAssets.forEach((assetPath) => {
    const fullPath = path.resolve(__dirname, assetPath);
    assert.ok(
      fs.existsSync(fullPath),
      `Required brand asset should exist: ${path.basename(assetPath)}`
    );
  });
});

test('brand assets: SVG files have consistent brand color usage', () => {
  const svgFiles = [
    path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-app-icon.svg'),
    path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-monogram.svg'),
  ];

  // Define brand colors
  const brandColors = [
    '#42107e', // deep purple
    '#7b2eff', // bright purple
    '#ff4fb8', // pink
    '#c5a6ff', // light purple
  ];

  svgFiles.forEach((filePath) => {
    const content = fs.readFileSync(filePath, 'utf8').toLowerCase();
    const fileName = path.basename(filePath);

    // Should use at least one brand color
    const usesBrandColor = brandColors.some((color) =>
      content.includes(color.toLowerCase())
    );

    assert.ok(
      usesBrandColor,
      `${fileName} should use at least one brand color`
    );
  });
});

test('brand assets: files have appropriate read permissions', () => {
  const assetFiles = [
    path.resolve(__dirname, '../../../apps/web/public/apple-touch-icon.png'),
    path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-app-icon.svg'),
    path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-brush-icon.svg'),
    path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-lockup.svg'),
    path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-monogram.svg'),
    path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-sprite.svg'),
    path.resolve(__dirname, '../../../apps/web/public/brand/swatchwatch-swatch-icon-1024.png'),
  ];

  assetFiles.forEach((filePath) => {
    assert.doesNotThrow(
      () => fs.readFileSync(filePath),
      `${path.basename(filePath)} should be readable`
    );
  });
});
