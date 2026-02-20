const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ENV_EXAMPLE_PATH = path.resolve(__dirname, '../../../.env.example');

function parseEnvFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const vars = {};
  const comments = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      return;
    }

    // Collect comments
    if (trimmed.startsWith('#')) {
      comments.push({ line: index + 1, text: trimmed });
      return;
    }

    // Parse variable assignments
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) {
      vars[match[1]] = {
        value: match[2],
        line: index + 1,
      };
    }
  });

  return { vars, comments, raw: content };
}

test('.env.example: file exists and is readable', () => {
  assert.doesNotThrow(
    () => fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8'),
    '.env.example should be readable'
  );
});

test('.env.example: has valid environment variable format', () => {
  const { vars } = parseEnvFile(ENV_EXAMPLE_PATH);

  assert.ok(
    Object.keys(vars).length > 0,
    '.env.example should contain at least one environment variable'
  );

  Object.keys(vars).forEach((varName) => {
    assert.match(
      varName,
      /^[A-Z_][A-Z0-9_]*$/,
      `Variable name "${varName}" should be uppercase with underscores`
    );
  });
});

test('.env.example: contains DATABASE_URL for local development', () => {
  const { vars } = parseEnvFile(ENV_EXAMPLE_PATH);

  assert.ok(vars.DATABASE_URL, 'should have DATABASE_URL');
  assert.match(
    vars.DATABASE_URL.value,
    /^postgres:\/\//,
    'DATABASE_URL should be a PostgreSQL connection string'
  );
  assert.match(
    vars.DATABASE_URL.value,
    /localhost/,
    'DATABASE_URL should point to localhost for local dev'
  );
});

test('.env.example: contains auth dev bypass configuration', () => {
  const { vars } = parseEnvFile(ENV_EXAMPLE_PATH);

  assert.ok(
    vars.NEXT_PUBLIC_AUTH_DEV_BYPASS,
    'should have NEXT_PUBLIC_AUTH_DEV_BYPASS'
  );
  assert.equal(
    vars.NEXT_PUBLIC_AUTH_DEV_BYPASS.value,
    'true',
    'dev bypass should be enabled in example'
  );
});

test('.env.example: contains Azure AD B2C placeholders', () => {
  const { vars } = parseEnvFile(ENV_EXAMPLE_PATH);

  assert.ok(
    vars.NEXT_PUBLIC_B2C_TENANT !== undefined,
    'should have NEXT_PUBLIC_B2C_TENANT'
  );
  assert.ok(
    vars.NEXT_PUBLIC_B2C_CLIENT_ID !== undefined,
    'should have NEXT_PUBLIC_B2C_CLIENT_ID'
  );

  // Should be empty or placeholder in example file
  assert.ok(
    vars.NEXT_PUBLIC_B2C_TENANT.value === '' ||
    vars.NEXT_PUBLIC_B2C_TENANT.value.includes('your') ||
    vars.NEXT_PUBLIC_B2C_TENANT.value.includes('todo'),
    'B2C tenant should be empty or placeholder'
  );
});

test('.env.example: has helpful comments', () => {
  const { comments } = parseEnvFile(ENV_EXAMPLE_PATH);

  assert.ok(
    comments.length > 0,
    '.env.example should have explanatory comments'
  );

  // Should have at least one comment explaining purpose
  const hasExplanation = comments.some((c) =>
    c.text.toLowerCase().includes('local') ||
    c.text.toLowerCase().includes('dev') ||
    c.text.toLowerCase().includes('auth') ||
    c.text.toLowerCase().includes('bypass')
  );

  assert.ok(
    hasExplanation,
    'should have comments explaining local dev or auth bypass'
  );
});

test('.env.example: uses safe default values for local development', () => {
  const { vars } = parseEnvFile(ENV_EXAMPLE_PATH);

  // Check that sensitive values are not hardcoded
  Object.entries(vars).forEach(([name, { value }]) => {
    if (name.includes('KEY') || name.includes('SECRET') || name.includes('PASSWORD')) {
      assert.ok(
        value === '' ||
        value.includes('your') ||
        value.includes('todo') ||
        value.includes('swatchwatch_dev'), // local dev password is acceptable
        `${name} should not contain production secrets`
      );
    }
  });
});

test('.env.example: database password is safe for local development', () => {
  const { vars } = parseEnvFile(ENV_EXAMPLE_PATH);

  if (vars.DATABASE_URL) {
    // Extract password from connection string
    const match = vars.DATABASE_URL.value.match(/postgres:\/\/[^:]+:([^@]+)@/);
    if (match) {
      const password = match[1];
      assert.ok(
        password.includes('dev') || password === 'password' || password === 'local',
        'database password should clearly be for local development only'
      );
    }
  }
});

test('.env.example: no trailing whitespace on lines', () => {
  const content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    if (line.length > 0 && line !== line.trimEnd()) {
      assert.fail(
        `Line ${index + 1} has trailing whitespace: "${line}"`
      );
    }
  });
});

test('.env.example: ends with newline', () => {
  const content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');

  assert.ok(
    content.endsWith('\n'),
    '.env.example should end with a newline'
  );
});

test('.env.example: variable naming follows conventions', () => {
  const { vars } = parseEnvFile(ENV_EXAMPLE_PATH);

  // Next.js public variables should be prefixed with NEXT_PUBLIC_
  Object.keys(vars).forEach((varName) => {
    if (varName.includes('CLIENT_ID') || varName.includes('TENANT') || varName.includes('B2C')) {
      if (!varName.startsWith('NEXT_PUBLIC_') && !varName.startsWith('AZURE_')) {
        // Only client-side B2C config should be NEXT_PUBLIC_
        // Server-side config can be without prefix
        assert.ok(
          varName.startsWith('NEXT_PUBLIC_') || !varName.includes('B2C') || varName.startsWith('AZURE_'),
          `Variable ${varName} should follow naming convention (NEXT_PUBLIC_ for client-side, AZURE_ for server-side)`
        );
      }
    }
  });
});

test('.env.example: contains only necessary variables for local development', () => {
  const { vars } = parseEnvFile(ENV_EXAMPLE_PATH);

  const expectedVars = [
    'DATABASE_URL',
    'NEXT_PUBLIC_AUTH_DEV_BYPASS',
    'NEXT_PUBLIC_B2C_TENANT',
    'NEXT_PUBLIC_B2C_CLIENT_ID',
  ];

  expectedVars.forEach((varName) => {
    assert.ok(
      vars[varName] !== undefined,
      `should have ${varName} for local development`
    );
  });
});

test('.env.example: variables are in logical order', () => {
  const content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  const lines = content.split('\n');

  // Find positions of key variables
  const positions = {};
  lines.forEach((line, index) => {
    if (line.startsWith('DATABASE_URL=')) positions.DATABASE_URL = index;
    if (line.startsWith('NEXT_PUBLIC_AUTH_DEV_BYPASS=')) positions.AUTH_DEV_BYPASS = index;
    if (line.startsWith('NEXT_PUBLIC_B2C')) positions.B2C = positions.B2C || index;
  });

  // DATABASE_URL should come before auth config
  if (positions.DATABASE_URL !== undefined && positions.AUTH_DEV_BYPASS !== undefined) {
    assert.ok(
      positions.DATABASE_URL < positions.AUTH_DEV_BYPASS,
      'DATABASE_URL should appear before auth configuration'
    );
  }

  // Auth dev bypass should come before B2C config
  if (positions.AUTH_DEV_BYPASS !== undefined && positions.B2C !== undefined) {
    assert.ok(
      positions.AUTH_DEV_BYPASS < positions.B2C,
      'Auth dev bypass should appear before B2C configuration'
    );
  }
});