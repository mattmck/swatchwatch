# Infrastructure — Terraform

All Azure resources are defined in this directory using Terraform (azurerm ~3.100).

## Resources Provisioned

| Resource | Terraform Resource | Purpose |
|----------|-------------------|---------|
| Resource Group | `azurerm_resource_group.main` | Container for all resources |
| Cosmos DB Account | `azurerm_cosmosdb_account.main` | Serverless NoSQL database |
| Cosmos DB Database | `azurerm_cosmosdb_sql_database.main` | `polish-inventory` database |
| Cosmos DB Container | `azurerm_cosmosdb_sql_container.polishes` | `polishes` container (partitioned by `/userId`) |
| Storage Account | `azurerm_storage_account.main` | Blob storage for images |
| Storage Container | `azurerm_storage_container.swatches` | Swatch photos |
| Storage Container | `azurerm_storage_container.nail_photos` | Nail photos |
| App Service Plan | `azurerm_service_plan.main` | Linux Consumption plan (Y1) |
| Function App | `azurerm_linux_function_app.main` | Node 20 function host |
| Static Web App | `azurerm_static_web_app.main` | Next.js frontend (Standard tier) |
| Speech Services | `azurerm_cognitive_account.speech` | Speech-to-text for voice input |

**Not in Terraform:** Azure AD B2C tenant — provisioned manually via the Azure portal.

## Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `location` | `eastus` | Azure region |
| `environment` | `dev` | Environment name (dev, staging, prod) |
| `base_name` | `polishinv` | Base name prefix for resources |

## Naming Convention

```
${base_name}-${environment}-${resource_type}-${random_8char_suffix}
```

Example: `polishinv-dev-cosmos-a3bc7f21`

The random suffix is generated once via `random_string.suffix` and reused across resources.

## Outputs

Key outputs after `terraform apply`:

- `function_app_hostname` — URL for the function API
- `static_web_app_hostname` — URL for the web frontend
- `cosmos_endpoint` — Cosmos DB endpoint
- `speech_service_key` — Speech services key (sensitive)

## Usage

```bash
cd infrastructure

# Initialize
terraform init

# Plan
terraform plan -var="environment=dev"

# Apply
terraform apply -var="environment=dev"

# Destroy
terraform destroy -var="environment=dev"
```

## Connecting Resources Post-Deploy

After `terraform apply`, copy the output values into `packages/functions/local.settings.json` for local development, or configure them as app settings on the deployed Function App.
