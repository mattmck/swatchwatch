# Infrastructure — Terraform

All Azure resources for SwatchWatch are defined in this directory using Terraform (azurerm ~3.100).

## Quick Start (Bootstrap)

**First-time setup:**

```bash
cd infrastructure
./bootstrap.sh
```

The interactive script handles everything:
- Prerequisites check (Azure CLI, Terraform)
- Configuration prompts (environment, region, GitHub repo)
- Secure password input (stored in Key Vault)
- Terraform init/plan/apply
- Outputs GitHub Secrets for CI/CD


**Seed data:** The dev database is seeded with realistic polish/brand/shade data via `packages/functions/migrations/003_seed_dev_data.sql`.


**Time:** ~5-10 minutes (Postgres provisioning is slow)

See full bootstrap guide at end of this file.

## Resources Provisioned

| Resource | Terraform Resource | Purpose |
|----------|-------------------|---------|
| Resource Group | `azurerm_resource_group.main` | Container for all resources |
| Key Vault | `azurerm_key_vault.main` | Secure secrets storage (PG password, API keys) |
| PostgreSQL Flexible Server | `azurerm_postgresql_flexible_server.main` | PostgreSQL 16 with pg_trgm + pgvector |
| PostgreSQL Database | `azurerm_postgresql_flexible_server_database.main` | `swatchwatch` database |
| Storage Account | `azurerm_storage_account.main` | Blob storage for images |
| Storage Container | `azurerm_storage_container.swatches` | Swatch photos |
| Storage Container | `azurerm_storage_container.nail_photos` | Nail photos |
| App Service Plan | `azurerm_service_plan.main` | Linux Consumption plan (Y1) |
| Function App | `azurerm_linux_function_app.main` | Node 20 function host (Managed Identity enabled) |
| Static Web App | `azurerm_static_web_app.main` | Next.js frontend (Standard tier) |
| Speech Services | `azurerm_cognitive_account.speech` | Speech-to-text for voice input |
| Azure AD Application | `azuread_application.github_actions` | GitHub Actions OIDC identity |
| Service Principal | `azuread_service_principal.github_actions` | Grants GitHub Actions access |
| Federated Credential | `azuread_application_federated_identity_credential.github_actions` | Passwordless OIDC trust |

**Not in Terraform:** Azure AD B2C tenant — provisioned manually via the Azure portal.

## Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `location` | `eastus` | Azure region |
| `environment` | `dev` | Environment name (dev, staging, prod) |
| `base_name` | `polishinv` | Base name prefix for resources |
| `pg_admin_username` | `pgadmin` | PostgreSQL admin username |
| `pg_admin_password` | *(required)* | PostgreSQL admin password (stored in Key Vault) |
| `github_repository` | `your-username/polish-inventory` | GitHub repo for OIDC federation |

**Sensitive variables** are stored in `terraform.tfvars` (gitignored) and created by `bootstrap.sh`.

## Security Features

✅ **Key Vault** — All secrets stored securely (PG password, API keys)  
✅ **Managed Identity** — Function App accesses Key Vault without passwords  
✅ **OIDC Federation** — GitHub Actions deploys without stored secrets  
✅ **Access Policies** — Least-privilege RBAC for all principals  
✅ **Audit Trail** — Key Vault logs all secret access  
✅ **Key Vault References** — Function App settings use `@Microsoft.KeyVault(...)` syntax

## Naming Convention

```
${base_name}-${environment}-${resource_type}-${random_8char_suffix}
```

Example: `polishinv-dev-cosmos-a3bc7f21`

The random suffix is generated once via `random_string.suffix` and reused across resources.

## Outputs

Key outputs after `terraform apply`:

| Output | Description |
|--------|-------------|
| `resource_group_name` | Name of the resource group |
| `function_app_name` | Function App name |
| `function_app_hostname` | Function App URL |
| `static_web_app_hostname` | Static Web App URL |
| `postgres_server_name` | PostgreSQL server name |
| `postgres_fqdn` | PostgreSQL connection hostname |
| `postgres_database_name` | Database name (`swatchwatch`) |
| `key_vault_name` | Key Vault name |
| `github_client_id` | Azure AD app ID for GitHub Actions *(add to GitHub Secrets as `AZURE_CLIENT_ID`)* |
| `github_tenant_id` | Azure AD tenant ID *(add to GitHub Secrets as `AZURE_TENANT_ID`)* |
| `subscription_id` | Azure subscription ID *(add to GitHub Secrets as `AZURE_SUBSCRIPTION_ID`)* |

The bootstrap script displays these values at the end.

## Manual Deployment (without bootstrap script)

If you prefer manual control:

```bash
cd infrastructure

# Create terraform.tfvars
cat > terraform.tfvars <<EOF
environment       = "dev"
location          = "eastus"
github_repository = "your-username/polish-inventory"
pg_admin_username = "pgadmin"
pg_admin_password = "your-secure-password"
EOF

# Initialize
terraform init

# Plan
terraform plan -out=tfplan

# Apply
terraform apply tfplan

# View outputs
terraform output
```

## Post-Deployment Steps

### 1. Add GitHub Secrets

Go to your GitHub repo → Settings → Secrets and variables → Actions

Add these 3 secrets (from `terraform output`):
- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

### 2. Run Database Migrations

```bash
cd ../packages/functions

export PGHOST=$(cd ../infrastructure && terraform output -raw postgres_fqdn)
export PGPORT=5432
export PGDATABASE=polish_inventory
export PGUSER="pgadmin@$(cd ../infrastructure && terraform output -raw postgres_server_name)"
export PGPASSWORD="your-password"

npm run migrate
psql -h $PGHOST -U $PGUSER -d $PGDATABASE -f ../../docs/seed_data_sources.sql
```

### 3. Add Additional Secrets to Key Vault

```bash
VAULT_NAME=$(cd infrastructure && terraform output -raw key_vault_name)

az keyvault secret set --vault-name $VAULT_NAME \
  --name azure-openai-key --value "your-key"

az keyvault secret set --vault-name $VAULT_NAME \
  --name azure-speech-key --value "your-key"
```

Then update Function App settings to reference them:
```bash
FUNC_NAME=$(cd infrastructure && terraform output -raw function_app_name)
RG_NAME=$(cd infrastructure && terraform output -raw resource_group_name)

az functionapp config appsettings set \
  --name $FUNC_NAME --resource-group $RG_NAME \
  --settings \
    AZURE_OPENAI_KEY="@Microsoft.KeyVault(SecretUri=https://${VAULT_NAME}.vault.azure.net/secrets/azure-openai-key)" \
    AZURE_SPEECH_KEY="@Microsoft.KeyVault(SecretUri=https://${VAULT_NAME}.vault.azure.net/secrets/azure-speech-key)"
```

## Destroying Infrastructure

```bash
cd infrastructure
terraform destroy
```

**Warning:** This permanently deletes all data. Key Vault secrets are soft-deleted (recoverable for 7 days).

To completely purge:
```bash
az keyvault purge --name $(terraform output -raw key_vault_name)
```
