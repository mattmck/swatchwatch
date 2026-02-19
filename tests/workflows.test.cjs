const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

test('.github/workflows/deploy-dev.yml has valid structure', async () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/deploy-dev.yml');
  const content = await fs.readFile(workflowPath, 'utf8');

  // Check for essential workflow elements
  assert.match(content, /name:\s*Deploy Dev/i, 'Should have workflow name');
  assert.match(content, /on:/i, 'Should have trigger configuration');
  assert.match(content, /jobs:/i, 'Should define jobs');
});

test('.github/workflows/deploy-dev.yml deploys web and functions', async () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/deploy-dev.yml');
  const content = await fs.readFile(workflowPath, 'utf8');

  assert.match(content, /deploy-web:/i, 'Should have deploy-web job');
  assert.match(content, /deploy-functions:/i, 'Should have deploy-functions job');
});

test('.github/workflows/deploy-dev.yml uses correct branches', async () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/deploy-dev.yml');
  const content = await fs.readFile(workflowPath, 'utf8');

  assert.match(content, /branches:\s*\[dev\]/i, 'Should trigger on dev branch');
});

test('.github/workflows/deploy-dev.yml builds shared package first', async () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/deploy-dev.yml');
  const content = await fs.readFile(workflowPath, 'utf8');

  // Web deployment should build shared first
  assert.match(content, /npm run build --workspace=packages\/shared/i, 'Should build shared package');
});

test('.github/workflows/deploy-dev.yml runs migrations', async () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/deploy-dev.yml');
  const content = await fs.readFile(workflowPath, 'utf8');

  assert.match(content, /npm run migrate/i, 'Should run database migrations');
  assert.match(content, /DATABASE_URL/i, 'Should use DATABASE_URL environment variable');
});

test('.github/workflows/deploy-infra-dev.yml has Terraform workflow', async () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/deploy-infra-dev.yml');
  const content = await fs.readFile(workflowPath, 'utf8');

  assert.match(content, /name:\s*Deploy Infrastructure Dev/i, 'Should have infrastructure workflow name');
  assert.match(content, /terraform/i, 'Should use Terraform');
  assert.match(content, /paths:.*infrastructure/is, 'Should trigger on infrastructure changes');
});

test('.github/workflows/deploy-infra-dev.yml detects infrastructure changes', async () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/deploy-infra-dev.yml');
  const content = await fs.readFile(workflowPath, 'utf8');

  assert.match(content, /detect-infra-changes:/i, 'Should have change detection job');
  assert.match(content, /infra_changed/i, 'Should output infra_changed flag');
});

test('.github/workflows/deploy-infra-dev.yml validates Terraform', async () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/deploy-infra-dev.yml');
  const content = await fs.readFile(workflowPath, 'utf8');

  assert.match(content, /terraform.*init/i, 'Should run terraform init');
  assert.match(content, /terraform.*validate/i, 'Should run terraform validate');
  assert.match(content, /terraform.*plan/i, 'Should run terraform plan');
  assert.match(content, /terraform.*apply/i, 'Should run terraform apply');
});

test('.github/workflows/deploy-infra-dev.yml uses Azure OIDC auth', async () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/deploy-infra-dev.yml');
  const content = await fs.readFile(workflowPath, 'utf8');

  assert.match(content, /id-token:\s*write/i, 'Should request id-token write permission');
  assert.match(content, /azure\/login@v2/i, 'Should use Azure login action');
  assert.match(content, /client-id:/i, 'Should configure OIDC client-id');
  assert.match(content, /tenant-id:/i, 'Should configure OIDC tenant-id');
  assert.match(content, /subscription-id:/i, 'Should configure OIDC subscription-id');
});

test('Workflow files are valid YAML', async () => {
  const workflows = [
    '../.github/workflows/deploy-dev.yml',
    '../.github/workflows/deploy-infra-dev.yml',
  ];

  for (const workflow of workflows) {
    const workflowPath = path.resolve(__dirname, workflow);
    const content = await fs.readFile(workflowPath, 'utf8');

    // Basic YAML structure validation
    assert.ok(content.startsWith('name:'), `${workflow} should start with name:`);
    assert.match(content, /on:/i, `${workflow} should have on: trigger`);
    assert.match(content, /jobs:/i, `${workflow} should have jobs: section`);

    // Should not have obvious YAML syntax errors
    assert.doesNotMatch(content, /\t/g, `${workflow} should not contain tabs (YAML uses spaces)`);
  }
});