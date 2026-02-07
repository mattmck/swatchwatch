module.exports = {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'polish-themed-message': (parsed) => {
          const { subject } = parsed;
          
          // Nail polish themed keywords/puns to look for
          const polishThemes = [
            // Colors
            'red', 'blue', 'pink', 'purple', 'green', 'yellow', 'orange', 'teal', 
            'coral', 'nude', 'beige', 'black', 'white', 'silver', 'gold', 'chrome',
            'shimmer', 'glitter', 'metallic', 'pearl', 'matte', 'glossy', 'holographic',
            'iridescent', 'duochrome', 'multichrome',
            
            // Polish terms
            'polish', 'lacquer', 'coat', 'topcoat', 'basecoat', 'gel', 'manicure',
            'nail', 'swatch', 'finish', 'formula', 'shade', 'bottle', 'brush',
            'chip', 'peel', 'cure', 'dry', 'glossy', 'sparkle', 'shine',
            
            // Polish puns & actions
            'buff', 'file', 'apply', 'remove', 'strip', 'layer', 'blend',
            'paint', 'coat', 'varnish', 'enamel', 'pigment', 'hue', 'tint',
            'nailed it', 'nail down', 'polished', 'shiny', 'smooth', 'flawless',
            'pristine', 'glazed', 'lacquered', 'painted', 'coated',
            
            // Brand/collection vibes
            'collection', 'brand', 'dupe', 'compare', 'match', 'swatch',
            'catalog', 'inventory', 'stash', 'haul'
          ];
          
          const lowerSubject = (subject || '').toLowerCase();
          const hasPolishTheme = polishThemes.some(theme => 
            lowerSubject.includes(theme)
          );
          
          return [
            hasPolishTheme,
            `Commit message must reference nail polish themes, colors, or puns! 💅\nExamples:\n  - feat: add glossy topcoat to polish detail view\n  - fix: chip in color matching algorithm\n  - refactor: polish the swatch rendering logic\n  - docs: nail down API endpoint documentation`
          ];
        }
      }
    }
  ],
  rules: {
    'polish-themed-message': [2, 'always'],
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'chore', 'refactor', 'test', 'style', 'perf', 'ci', 'build', 'revert']
    ],
    // Allow any subject casing (no sentence-case enforcement)
    'subject-case': [0],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'type-case': [2, 'always', 'lower-case'],
    'type-empty': [2, 'never']
  }
};
