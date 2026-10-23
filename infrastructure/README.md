# Infrastructure — Terraform

All Azure resources for SwatchWatch are defined in this directory using Terraform (azurerm ~4.50).

## Quick Start (Bootstrap)

**First-time setup:**

```bash
cd infrastructure
./bootstrap.sh
```

The interactive script handles everything:
- Prerequisites check (Azure CLI, Terraform)
- Configuration prompts (environment, region, GitHub repo, remote state backend)
- Secure password input (stored in Key Vault)
- Terraform backend init/reconfigure + plan/apply
- Outputs GitHub Secrets for CI/CD

Bootstrap writes environment-specific variable and plan files:
- `terraform.<environment>.tfvars` (gitignored)
- `tfplan.<environment>` (gitignored)


**Seed data:** The dev database is seeded with realistic polish/brand/shade data via `packages/functions/migrations/003_seed_dev_data.sql`.


**Time:** ~5-10 minutes (Postgres provisioning is slow)

Bootstrap expects an existing Terraform state resource group + storage account and creates the state container automatically if needed. By default, it suggests `swatchwatch-tfstate-rg` and `<environment>.terraform.tfstate`.

See full bootstrap guide at end of this file.

## State Migration: OpenAI count → for_each

The OpenAI resources were refactored from `count`-based to `for_each`-based (keyed by region) in the multi-region PR. Existing stacks whose state still references the old indexed addresses (`[0]`) must be migrated before running `terraform apply`, or Terraform will try to destroy and recreate the resources.

Run these commands once per environment, substituting your primary OpenAI region:

```bash
PRIMARY_REGION="centralus"  # replace with your actual primary region

terraform state mv \
  'azurerm_cognitive_account.openai[0]' \
  "azurerm_cognitive_account.openai[\"${PRIMARY_REGION}\"]"

terraform state mv \
  'azurerm_cognitive_deployment.openai_hex[0]' \
  "azurerm_cognitive_deployment.openai_hex[\"${PRIMARY_REGION}\"]"

# Only if a separate batch deployment exists in state:
terraform state mv \
  'azurerm_cognitive_deployment.openai_hex_batch[0]' \
  "azurerm_cognitive_deployment.openai_hex_batch[\"${PRIMARY_REGION}\"]"

terraform state mv \
  'azurerm_monitor_diagnostic_setting.openai[0]' \
  "azurerm_monitor_diagnostic_setting.openai[\"${PRIMARY_REGION}\"]"
```

After migration, run `terraform plan` — it should show no destructive changes to OpenAI resources.

## GitHub Infra Deployment (Dev + Prod)

Terraform infrastructure deploys in CI via:
- `.github/workflows/deploy-infra.yml` (reusable)
- `.github/workflows/deploy-dev.yml` (on `dev`, runs infra first when `infrastructure/**` or the infra workflow changed, then app deploy)
- `.github/workflows/deploy-infra-dev.yml` (caller, `dev`, manual infra-only)
- `.github/workflows/deploy-infra-prod.yml` (caller, `prod`, manual infra-only)
- `.github/workflows/deploy-prod.yml` (on `main`, runs infra first when `infrastructure/**` or the infra workflow changed, then app deploy)

### Deploy ordering

Function App app settings are Terraform-managed (`azurerm_linux_function_app.main`), but the code deploy writes them too: `Azure/functions-action` reads the full settings when it starts and, on Linux Consumption, PUTs that whole set back with the new `WEBSITE_RUN_FROM_PACKAGE` (and `WEBSITE_ENABLE_SYNC_UPDATE_SITE`) about a minute later. A Terraform apply that lands in between is silently reverted. On 2026-10-23 the #408 merge started Deploy Infrastructure Dev and Deploy Dev in the same second; the action read the settings at 00:57:19Z, Terraform wrote `SHAREABLE_LOOKS_ENABLED` at 00:57:20–49Z, and the action's write after 00:57:40Z dropped it again.

Rules:

1. **Infra runs before the code deploy, in one workflow.** `deploy-dev.yml` and `deploy-prod.yml` run `deploy-infra.yml` first when infra files changed and start `deploy.yml` only after it succeeds. The `Deploy Infrastructure Dev` / `Prod` workflows are manual-only. Don't dispatch one while a Deploy Dev / Deploy Prod run (or a manual `Deploy Application`) is in progress for the same environment.
2. **Each key has one owner.** Terraform declares every app setting, including `FUNCTIONS_NODE_BLOCK_ON_ENTRY_POINT_ERROR` (previously set only by `deploy.yml`, so every apply removed it). The keys the deploy action writes (`WEBSITE_RUN_FROM_PACKAGE`, `WEBSITE_ENABLE_SYNC_UPDATE_SITE`) and `WEBSITE_MOUNT_ENABLED` are in `lifecycle.ignore_changes`. `deploy.yml` still sets `AUTH_DEV_BYPASS=false` and the `AZURE_AD_B2C_*` values from the same GitHub settings Terraform reads.
3. **Both sides check.** `.github/scripts/check-function-app-settings.sh` compares the live app (`az functionapp config appsettings list`) with `azurerm_linux_function_app.main` in the Terraform state and fails when a setting is missing or has another value (names only, never values; ignored keys skipped). Deploy Infrastructure runs it after `terraform apply`; `deploy.yml` runs it in the `Verify Function App Settings` job after the code deploy. If it fails, re-run Deploy Infrastructure for that environment.

GitHub `concurrency` groups are not used to serialize infra and code deploys: a group keeps one pending run and cancels the older pending one, which could silently drop a queued infra apply.

State is stored in Azure Blob Storage using Terraform's native `azurerm` backend (configured in `main.tf` with `backend "azurerm" {}`).

Required GitHub Actions configuration (per GitHub environment):
- Secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
- Variables: `TFSTATE_RESOURCE_GROUP`, `TFSTATE_STORAGE_ACCOUNT`, `TFSTATE_CONTAINER` (recommended: `tfstate`), `TFSTATE_BLOB_NAME` (recommended: `<environment>.terraform.tfstate`)
- OpenAI mode variable: `CREATE_OPENAI_RESOURCES` (`true` to let Terraform manage OpenAI account/deployment; default in workflow is `true`)
- **OpenAI region (required when `CREATE_OPENAI_RESOURCES` is true):** `OPENAI_LOCATION` (single region the environment's account already lives in: **prod `centralus`, dev `eastus`**; exported as `TF_VAR_openai_location`) or `OPENAI_REGIONS` (JSON list, takes precedence; single-region e.g. `["centralus"]`, multi-region opt-in e.g. `["centralus","southcentralus","eastus","eastus2"]`). The workflow has **no default region** and fails before `terraform init` when neither is set. See [Azure OpenAI region and replacement guard](#azure-openai-region-and-replacement-guard)
- OpenAI deployment variables (exported as `TF_VAR_*`): `OPENAI_DEPLOYMENT_NAME` (default `hex-detector`), `OPENAI_BATCH_DEPLOYMENT_NAME` (default `hex-detector-batch`), optional `OPENAI_BATCH_MODEL_NAME`, `OPENAI_BATCH_MODEL_VERSION`, `OPENAI_BATCH_DEPLOYMENT_SKU_NAME`, `OPENAI_BATCH_DEPLOYMENT_CAPACITY`
- Optional variables for shared/external OpenAI accounts (used when `CREATE_OPENAI_RESOURCES=false`): `OPENAI_ENDPOINT`, `OPENAI_ACCOUNT_NAME`
Recommended auth config (propagated to Terraform `TF_VAR_*` inputs):
- Secrets: `AZURE_AD_B2C_CLIENT_ID`
- Variables: `AUTH_DEV_BYPASS`, `AZURE_AD_B2C_TENANT` (falls back to `NEXT_PUBLIC_B2C_TENANT` if unset)
- Feature flags: `SHAREABLE_WISHLIST_ENABLED` (default `false`; exported as `TF_VAR_shareable_wishlist_enabled`), `SHAREABLE_LOOKS_ENABLED` (default `false`; exported as `TF_VAR_shareable_looks_enabled`)
- External ID service principal (opt-in, see [External ID service principal](#external-id-service-principal-opt-in)): variables `MANAGE_CIAM_SERVICE_PRINCIPAL` (default `false`), `CIAM_TENANT_ID`, `CIAM_TERRAFORM_CLIENT_ID` (exported as `TF_VAR_manage_ciam_service_principal`, `TF_VAR_ciam_tenant_id`, `TF_VAR_ciam_terraform_client_id`)
- Alerts (observability Phase 3, #281): `ALERT_EMAIL` (**secret** recommended so the address is masked in logs; a variable also works; exported as `TF_VAR_alert_email`, never committed to tfvars) and optional variable `ALERTS_ENABLED` (default `true` for `prod`, `false` otherwise; exported as `TF_VAR_alerts_enabled`)
The workflow creates the state container automatically if it does not exist.
The workflow reads the `pg-password` secret from Key Vault and exports it as `TF_VAR_pg_admin_password` for Terraform.
In external OpenAI mode (`CREATE_OPENAI_RESOURCES=false`), the workflow resolves the OpenAI account name from `OPENAI_ACCOUNT_NAME`, Terraform output, or endpoint hostname and loads that account key into `TF_VAR_openai_api_key` before Terraform runs.

### Azure OpenAI region and replacement guard

An Azure OpenAI account's `location` is immutable, so a plan with a different region **destroys the account** (soft-delete, with every model deployment) and creates a new one. On 2026-10-19 a manual `deploy-infra.yml` dispatch for prod did exactly that: the `openai_location` input defaulted to `eastus` (dev's region) while prod's account lives in `centralus`, so Terraform soft-deleted `swatchwatch-prod-openai-*` and its `hex-detector` / `hex-detector-batch` deployments (recovered with `az cognitiveservices account recover`). Three rules now prevent a repeat:

1. **The environment owns the region.** Each GitHub environment sets `OPENAI_LOCATION` (prod: `centralus`, dev: `eastus`) or `OPENAI_REGIONS`. The reusable workflow has no default; when `CREATE_OPENAI_RESOURCES` is true and neither variable nor the input is set, the **Validate Azure OpenAI region** step fails with `::error::` before `terraform init`. Terraform itself refuses to plan `azurerm_cognitive_account.openai` without an explicit `openai_regions` / `openai_location` (precondition in `main.tf`); it never falls back to `location`.
2. **Manual dispatches must not pass a different region.** The `openai_location` input on `Deploy Infrastructure` (manual dispatch and `workflow_call`) is an explicit override with **no default**. Leave it empty. If it is set and differs from the environment's `OPENAI_LOCATION`, the run fails unless `allow_openai_replace` is true (and `OPENAI_REGIONS`, when set, wins over the input anyway). The committed callers (`deploy-prod.yml`, `deploy-infra-prod.yml`: `centralus`; `deploy-infra-dev.yml`: `eastus`) pass the region their environment already uses, which is why they keep working before the variables are set.
3. **Plan guard.** Between `terraform plan` and `terraform apply` the **Guard against Azure OpenAI account replacement** step runs `terraform show -json tfplan` and fails with `::error::` (listing the addresses) if any `azurerm_cognitive_account` or `azurerm_cognitive_deployment` has a `delete` or replace (`delete`+`create`) action. This covers every Cognitive Services account (OpenAI, Speech, Document Intelligence). Only the boolean input `allow_openai_replace=true` lets such a plan apply (with a `::warning::`); it defaults to `false` and the committed callers never set it, so a push to `main` cannot replace an account either.

To move or recreate an account on purpose: change the environment's `OPENAI_LOCATION` / `OPENAI_REGIONS` first, **and** update the hardcoded `openai_location` in the committed callers (`deploy-prod.yml` and `deploy-infra-prod.yml` for prod, `deploy-infra-dev.yml` for dev). Those callers pass their old region as the input on every push, and rule 2 fails a run whose input differs from the variable, so a push-triggered deploy would break after the move (or, with `allow_openai_replace`, move it back). Then dispatch `Deploy Infrastructure` with `allow_openai_replace: true`, and update the Function App's `AZURE_OPENAI_*` settings (Terraform rewires them from the new primary account).

## Resources Provisioned

| Resource | Terraform Resource | Purpose |
|----------|-------------------|---------|
| Resource Group | `azurerm_resource_group.main` | Container for all resources |
| Key Vault | `azurerm_key_vault.main` | Secure secrets storage (PG password, API keys) |
| Key Vault Secret | `azurerm_key_vault_secret.image_proxy_signing_key` (from `random_password.image_proxy_signing_key`) | 64-char HMAC key exposed to Functions as `IMAGE_PROXY_SIGNING_KEY` (Key Vault reference) to sign `/api/images/{id}` capability URLs. Replace the `random_password` to rotate; previously issued image URLs stop working. |
| PostgreSQL Flexible Server | `azurerm_postgresql_flexible_server.main` | PostgreSQL 16 with pg_trgm + pgvector; point-in-time restore for `pg_backup_retention_days` (default 35) |
| PostgreSQL Database | `azurerm_postgresql_flexible_server_database.main` | `swatchwatch` database |
| Storage Account | `azurerm_storage_account.main` | Blob storage for images and the Terraform state; blob versioning, change feed, and blob + container soft delete (`blob_soft_delete_retention_days`) |
| Storage Management Policy | `azurerm_storage_management_policy.main` | Expires old blob versions (media `blob_version_retention_days`, tfstate `tfstate_version_retention_days`, connector-raw 7 days) and `pg-restores` dumps after 14 days |
| Storage Container | `azurerm_storage_container.swatches` | Swatch photos |
| Storage Container | `azurerm_storage_container.nail_photos` | Nail photos (private user media). Name exposed to Functions as `USER_MEDIA_CONTAINER`; readable only through owner-scoped `v3` image ids (#227). |
| Storage Container | `azurerm_storage_container.tfstate` | **Live** Terraform remote state for this environment (the azurerm backend points here). Never remove it |
| Backup Vault *(backups)* | `azurerm_data_protection_backup_vault.main` | Azure Backup vault (locally redundant, soft delete 14 days, immutability unlocked); `backup_vault_enabled`, prod only by default |
| Postgres vault backup *(backups)* | `azurerm_data_protection_backup_policy_postgresql_flexible_server.weekly`, `azurerm_data_protection_backup_instance_postgresql_flexible_server.main` | Weekly (Sun 07:00 UTC) full logical backup of the server, kept `pg_vault_backup_retention` (3 months); first of each month kept `vault_backup_monthly_retention` (1 year). Survives server deletion |
| Nail-photo vault backup *(backups)* | `azurerm_data_protection_backup_policy_blob_storage.nail_photos`, `azurerm_data_protection_backup_instance_blob_storage.nail_photos` | Daily (06:00 UTC) vaulted copy of the `nail-photos` container, kept `nail_photo_vault_backup_retention` (30 days); first of each month kept 1 year. Survives storage account deletion |
| Storage Container *(backups)* | `azurerm_storage_container.pg_restores` | `pg-restores`: target for Postgres vault restores (restored as dump files) |
| Role Assignments *(backups)* | `azurerm_role_assignment.backup_vault_*` | Vault identity: Reader on the resource group, PostgreSQL Flexible Server Long Term Retention Backup Role on the server, Storage Account Backup Contributor on the storage account, Storage Blob Data Contributor on `pg-restores` |
| Delete Locks *(locks)* | `azurerm_management_lock.data["postgres"\|"storage"\|"backup_vault"]` | `CanNotDelete` locks (`delete_locks_enabled`, prod only by default) |
| Log Analytics Workspace | `azurerm_log_analytics_workspace.main` | Centralized log storage/query backend (daily quota = `appinsights_daily_cap_gb`) |
| Application Insights | `azurerm_application_insights.main` | Function telemetry, traces, requests, and exceptions (daily cap = `appinsights_daily_cap_gb`) |
| Action Group *(alerts)* | `azurerm_monitor_action_group.main` | Emails `alert_email` for every alert below (`alerts_enabled`, prod only by default) |
| API 5xx alert *(alerts)* | `azurerm_monitor_metric_alert.api_5xx` | App Insights `requests/failed` with result code `5xx` > `alert_api_5xx_threshold` in 5 min (sev 1) |
| Exception spike alert *(alerts)* | `azurerm_monitor_scheduled_query_rules_alert_v2.exception_spike` | `AppExceptions` split by client kind over 15 min: server > `alert_server_exception_threshold`, browser > `alert_browser_exception_threshold` (sev 2) |
| Ingestion failure alert *(alerts)* | `azurerm_monitor_scheduled_query_rules_alert_v2.ingestion_failed` | Any `ingestion.job_failed` custom event (emitted by `markIngestionJobFailed`) in 15 min (sev 2) |
| Daily cap alert *(alerts)* | `azurerm_monitor_scheduled_query_rules_alert_v2.daily_cap` | `_LogOperation` reports `OverQuota`: the workspace daily cap stopped ingestion (sev 2) |
| Availability tests *(alerts)* | `azurerm_application_insights_standard_web_test.availability["web"\|"api"]` | Standard tests every `availability_test_frequency_seconds` from `availability_test_locations`: web home page (custom domain) and `GET /api/reference/finishes`; expect 200 and an SSL cert valid for 7+ days. Billed per execution |
| Availability alerts *(alerts)* | `azurerm_monitor_metric_alert.availability["web"\|"api"]` | Fires when 2+ test locations fail (sev 1) |
| API Management *(optional)* | `azurerm_api_management.main` | Azure API Management Consumption gateway for Azure OpenAI traffic (`apim_enabled=true`) |
| App Service Plan | `azurerm_service_plan.main` | Linux Consumption plan (Y1) |
| Function App | `azurerm_linux_function_app.main` | Node 22 function host (Managed Identity enabled) |
| Static Web App | `azurerm_static_web_app.main` | Next.js frontend (Standard tier) |
| Document Intelligence *(optional)* | `azurerm_cognitive_account.document_intelligence` | Server-side OCR for capture pipeline label/barcode extraction (`enable_document_intelligence=true`) |
| Speech Services | `azurerm_cognitive_account.speech` | Speech-to-text for voice input |
| Azure OpenAI Account(s) *(optional)* | `azurerm_cognitive_account.openai` | One OpenAI account per configured region for hex color detection (`create_openai_resources=true`; `openai_regions` list) |
| Azure OpenAI Deployment(s) *(optional)* | `azurerm_cognitive_deployment.openai_hex` | `hex-detector` deployment created in every Terraform-managed OpenAI region |
| Azure OpenAI Batch Deployment(s) *(optional)* | `azurerm_cognitive_deployment.openai_hex_batch` | `hex-detector-batch` deployment created in every Terraform-managed OpenAI region when batch deployment name differs |
| Azure OpenAI Diagnostic Setting(s) *(optional)* | `azurerm_monitor_diagnostic_setting.openai` | Sends per-region OpenAI logs/metrics to Log Analytics (when OpenAI resources are provisioned) |
| Custom Domain | `azurerm_static_web_app_custom_domain.dev` | Maps `dev.swatchwatch.app` in dev and `swatchwatch.app` in prod |
| Azure AD Application | `azuread_application.github_actions` | GitHub Actions OIDC identity |
| Service Principal | `azuread_service_principal.github_actions` | Grants GitHub Actions access |
| Federated Credential | `azuread_application_federated_identity_credential.github_actions` | Passwordless OIDC trust |
| External ID enterprise app *(opt-in)* | `azuread_service_principal.ciam_web` (provider `azuread.ciam`) | Service principal of the web sign-in app (`azure_ad_b2c_client_id`) in the External ID tenant, imported by client id. Only `app_role_assignment_required = false` is managed (other attributes are `ignore_changes`); `prevent_destroy` is on. Created only when `manage_ciam_service_principal = true` |

**Not in Terraform:** the Entra External ID tenants, the web sign-in **app registration** (redirect URIs, app roles such as `admin`, optional claims, user flows) and the CIAM deployer app used to manage the service principal — all hand-managed in the portal. Only the web app's service principal is Terraform-managed, and only where `manage_ciam_service_principal = true`.

## Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `subscription_id` | *(required)* | Azure subscription ID (required by azurerm provider v4+) |
| `location` | `centralus` | Azure region |
| `openai_location` | `null` | OpenAI region when `openai_regions` is empty; must be the region the environment's account already lives in (prod `centralus`, dev `eastus`) since a change replaces the account. Required (or `openai_regions`) when `create_openai_resources=true`; never derived from `location` |
| `openai_regions` | `[]` | OpenAI regions to provision when `create_openai_resources=true` (takes precedence over `openai_location`); first region is primary for `AZURE_OPENAI_ENDPOINT`/`AZURE_OPENAI_KEY` outputs and Function settings |
| `environment` | `dev` | Environment name (dev, staging, prod) |
| `base_name` | `swatchwatch` | Base name prefix for resources |
| `pg_admin_username` | `pgadmin` | PostgreSQL admin username |
| `pg_admin_password` | *(required)* | PostgreSQL admin password (stored in Key Vault) |
| `github_repository` | `your-github-username/swatchwatch` | GitHub repo for OIDC federation |
| `apim_enabled` | `false` | Provision an Azure API Management instance for Azure OpenAI gateway routing (opt-in) |
| `apim_sku_name` | `Consumption_0` | APIM SKU (Consumption tier default for cost control) |
| `apim_publisher_name` | `SwatchWatch` | APIM publisher display name |
| `apim_publisher_email` | `platform@swatchwatch.app` | APIM publisher contact email |
| `apim_openai_api_suffix` | `openai-gateway` | APIM API path suffix for Azure OpenAI proxy calls |
| `apim_openai_subscription_key` | `""` | Optional APIM subscription key stored in Key Vault and exposed to Functions as `AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY` |
| `apim_openai_subscription_key_uri` | `""` | Optional existing Key Vault secret URI for APIM subscription key. When set, Terraform reuses it and does not create `apim-openai-subscription-key`. |
| `openai_gateway_enabled` | `false` | Function App setting `AZURE_OPENAI_USE_GATEWAY`; keep false until APIM API routes/policies are configured |
| `openai_custom_subdomain_name` | `null` | Optional custom subdomain override for the primary Azure OpenAI account. Additional regions always use generated per-region subdomains. |
| `create_openai_resources` | `false` | Provision Azure OpenAI account/deployment in this stack (disable when quota is unavailable) |
| `openai_endpoint` | `""` | Existing Azure OpenAI endpoint when reusing an external account (`create_openai_resources=false`) |
| `openai_api_key` | `""` | Existing Azure OpenAI API key when reusing an external account (`create_openai_resources=false`) |
| `openai_key_vault_secret_uri` | `""` | Existing Key Vault secret URI for Azure OpenAI key (preferred over `openai_api_key` to avoid passing key through Terraform) |
| `openai_deployment_name` | `hex-detector` | Azure OpenAI deployment name exposed to Functions as `AZURE_OPENAI_DEPLOYMENT_HEX` |
| `openai_batch_deployment_name` | `""` | Optional Azure OpenAI batch deployment name exposed as `AZURE_OPENAI_DEPLOYMENT_HEX_BATCH` (falls back to `openai_deployment_name` when empty). When `create_openai_resources=true` and this is set to a different value than `openai_deployment_name`, Terraform creates `azurerm_cognitive_deployment.openai_hex_batch`; when `create_openai_resources=false` (external OpenAI mode), this only affects the Functions app setting value. |
| `openai_model_name` | `gpt-4o-mini` | Azure OpenAI model name for the hex detector deployment |
| `openai_model_version` | `2024-07-18` | Azure OpenAI model version for the hex detector deployment |
| `openai_deployment_capacity` | `100` | Provisioned throughput units for the OpenAI deployment (`GlobalStandard` SKU) |
| `openai_batch_model_name` | `""` | Optional model name for the Terraform-managed batch deployment (falls back to `openai_model_name`). Only used when Terraform creates `azurerm_cognitive_deployment.openai_hex_batch` (`create_openai_resources=true` and `openai_batch_deployment_name` set and different from `openai_deployment_name`); has no effect for external OpenAI mode or the shared sync deployment. |
| `openai_batch_model_version` | `""` | Optional model version for the Terraform-managed batch deployment (falls back to `openai_model_version`). Only used when Terraform creates `azurerm_cognitive_deployment.openai_hex_batch` (`create_openai_resources=true` and `openai_batch_deployment_name` set and different from `openai_deployment_name`); has no effect for external OpenAI mode or the shared sync deployment. |
| `openai_batch_deployment_sku_name` | `GlobalBatch` | SKU name for Terraform-managed batch deployment |
| `openai_batch_deployment_capacity` | `5000` | Capacity for the Terraform-managed batch deployment. For `GlobalBatch` this is the enqueued-token limit in thousands (5000 = 5M tokens), not a billed throughput reservation. At `100` (100K tokens) a single 100-image ingestion page was rejected with `token_limit_exceeded`. |
| `enable_document_intelligence` | `false` | Provision Azure AI Document Intelligence for server-side OCR in capture pipeline |
| `is_automation` | `false` | Flag for CI/CD pipelines (skips deployer Key Vault access policy) |
| `domain_name` | `swatchwatch.app` | Root domain name for the application (used for custom domains and CORS; prod allows both apex and `www`) |
| `azure_ad_b2c_tenant` | `to-be-added` | Azure AD B2C/Entra External ID tenant name applied to Function App setting `AZURE_AD_B2C_TENANT` |
| `azure_ad_b2c_client_id` | `to-be-added` | Azure AD B2C/Entra External ID app client ID applied to Function App setting `AZURE_AD_B2C_CLIENT_ID` |
| `manage_ciam_service_principal` | `false` | Import and manage the web sign-in app's service principal in the External ID tenant (sets `app_role_assignment_required = false`). Turn on per environment only after checking that tenant's current setting; see [External ID service principal](#external-id-service-principal-opt-in) |
| `ciam_tenant_id` | `""` | External ID (CIAM) tenant ID for the `azuread.ciam` provider. Required when `manage_ciam_service_principal = true` |
| `ciam_terraform_client_id` | `""` | Client ID of the deployer app in the CIAM tenant; Deploy Infra signs in to it with GitHub OIDC. Empty = Azure CLI credentials (local runs) |
| `auth_dev_bypass` | `false` | Controls Function App setting `AUTH_DEV_BYPASS`; keep `false` to require JWT validation |
| `shareable_wishlist_enabled` | `false` | Controls Function App setting `SHAREABLE_WISHLIST_ENABLED` (opt-in public wishlist links, #268). Set the `SHAREABLE_WISHLIST_ENABLED` repository/environment variable to `true` and run Deploy Infra to ship it; app settings are Terraform-managed, so a portal-only change is reverted by the next infra apply |
| `shareable_looks_enabled` | `false` | Controls Function App setting `SHAREABLE_LOOKS_ENABLED` (opt-in public share links for saved looks). Set the `SHAREABLE_LOOKS_ENABLED` repository/environment variable to `true` and run Deploy Infra to ship it; app settings are Terraform-managed, so a portal-only change is reverted by the next infra apply |
| `ingestion_job_queue_name` | `ingestion-jobs` | Function App queue name for ingestion worker (`INGESTION_JOB_QUEUE_NAME`) |
| `azure_openai_batch_api_version` | `2025-03-01-preview` | Function App setting `AZURE_OPENAI_BATCH_API_VERSION` for Files/Batch endpoints |
| `azure_openai_batch_completion_window` | `24h` | Function App setting `AZURE_OPENAI_BATCH_COMPLETION_WINDOW` sent during batch creation |
| `azure_openai_vision_detail` | `low` | Function App setting `AZURE_OPENAI_VISION_DETAIL` — image detail level (`low`/`high`/`auto`) for vision hex detection |
| `hex_detection_batch_enabled` | `false` | Feature-flag Function App setting `HEX_DETECTION_BATCH_ENABLED` |
| `hex_detection_batch_min_images` | `5` | Function App setting `HEX_DETECTION_BATCH_MIN_IMAGES` threshold before batch mode |
| `hex_detection_snap_enabled` | `false` | Feature-flag Function App setting `HEX_DETECTION_SNAP_ENABLED` — snap vision-detected hexes to the nearest palette chip measured from the same image (`detected_hex_method = 'vision-snap'`) |
| `ingestion_ai_batch_poll_schedule` | `0 */2 * * * *` | Function App setting `INGESTION_AI_BATCH_POLL_SCHEDULE` for timer polling |
| `ingestion_ai_batch_max_poll_jobs` | `10` | Function App setting `INGESTION_AI_BATCH_MAX_POLL_JOBS` per poll run |
| `appinsights_daily_cap_gb` | `null` (→ `appinsights_daily_cap_gb_defaults`) | Daily ingestion cap (GB) for Application Insights and the Log Analytics workspace; telemetry stops for the rest of the day once hit (the daily cap alert reports it) |
| `appinsights_daily_cap_gb_defaults` | `{ dev = 0.5, prod = 2 }` | Per-environment default cap when `appinsights_daily_cap_gb` is null; unlisted environments use the `dev` entry (decision D15) |
| `alerts_enabled` | `null` (→ `true` prod, `false` otherwise) | Create the action group, alert rules and availability tests (decision D16) |
| `alert_email` | `""` | Address the action group emails. Comes from the `ALERT_EMAIL` GitHub secret/variable; do not commit it. Empty = alerts fire in the portal only (a `check` warns on plan) |
| `alert_api_5xx_threshold` | `5` | 5xx responses (per result code) in 5 min before the API alert fires |
| `alert_server_exception_threshold` | `10` | Functions exceptions in 15 min before the exception spike alert fires |
| `alert_browser_exception_threshold` | `25` | Browser exceptions in 15 min before the exception spike alert fires |
| `availability_test_frequency_seconds` | `300` | Availability test interval per location (`300`, `600` or `900`) |
| `availability_test_locations` | East US, South Central US, West US | Availability test geo location ids (at least 2) |
| `pg_backup_retention_days` | `35` | Postgres point-in-time restore window (7–35 days) |
| `blob_soft_delete_retention_days` | `30` | Days deleted blobs and containers stay recoverable |
| `blob_version_retention_days` | `30` | Days previous swatch / nail-photo blob versions are kept |
| `tfstate_version_retention_days` | `90` | Days previous Terraform state versions are kept |
| `backup_vault_enabled` | `null` (→ `true` prod, `false` otherwise) | Create the Azure Backup vault, policies and backup instances |
| `delete_locks_enabled` | `null` (→ `true` prod, `false` otherwise) | `CanNotDelete` locks on the Postgres server, storage account and backup vault |
| `pg_vault_backup_retention` | `P3M` | Retention of weekly Postgres vault backups (ISO 8601). Changing it replaces the policy, see [Backups & Restore](#backups--restore) |
| `nail_photo_vault_backup_retention` | `P30D` | Retention of daily nail-photo vault backups (ISO 8601) |
| `vault_backup_monthly_retention` | `P1Y` | Retention of the first vault backup of each month (both policies) |

**Sensitive variables** are stored in environment-specific tfvars files (gitignored), for example:
- `terraform.dev.tfvars`
- `terraform.prod.tfvars`

## Security Features

✅ **Key Vault** — All secrets stored securely (PG password, API keys)  
✅ **Managed Identity** — Function App accesses Key Vault without passwords  
✅ **OIDC Federation** — GitHub Actions deploys without stored secrets  
✅ **Access Policies** — Least-privilege RBAC for all principals  
✅ **Audit Trail** — Key Vault logs all secret access  
✅ **OpenAI Observability** — Azure OpenAI diagnostic logs/metrics flow into the shared Log Analytics/App Insights workspace  
✅ **Key Vault References** — Function App settings use `@Microsoft.KeyVault(...)` syntax
✅ **Versionless Secret URIs** — Function App secret references use Key Vault `versionless_id` to avoid app-setting churn on each secret version rotation

## Backups & Restore

What is protected, and how far back you can go:

| Data | Protection | Window |
|------|------------|--------|
| Postgres (all user data, catalog, admin labels) | Built-in point-in-time restore | `pg_backup_retention_days` (35 days), any second |
| Postgres | Backup vault, weekly full logical backup *(prod)* | 3 months weekly, 1 year monthly; survives server deletion |
| `nail-photos` (private user media, the only copy) | Soft delete + versioning, plus a daily vaulted backup *(prod)* | 30 days locally; vault 30 days daily, 1 year monthly; survives account deletion |
| `swatches`, `connector-raw` | Soft delete + versioning | 30 days (connector-raw versions 7 days); regenerable from vendors / connectors |
| Terraform state (`tfstate` container) | Soft delete + versioning | 90 days of prior versions |
| Key Vault secrets | Soft delete; purge protection in prod | 7 days (the window is fixed at vault creation) |
| Delete locks *(prod)* | `CanNotDelete` on Postgres, storage account, backup vault | — |

Nothing is geo-redundant (intentional). Redis (cache), App Insights (logs), and the web/Functions code (git) need no backups.

**First apply.** The vault's role assignments and the delete locks need `Microsoft.Authorization/*/write`, which the GitHub Actions service principal (Contributor) doesn't have. Run the first prod apply of this change locally as a user with Owner or User Access Administrator; later CI applies only read them. Locks also block deleting child resources (storage containers, Postgres firewall rules) until removed: `az lock delete --name <name> --resource-group <rg> --resource-type ... --resource <name>`.

**Changing vault retention.** Backup policies can't be edited in place and can't be replaced while an instance uses them. Add a new policy, point the backup instance at it, apply, then remove the old one.

### Restore procedures

- **Postgres, point in time** (bad migration, bad bulk write within 35 days): restore into a new server, check it, then point `PGHOST` at it (or copy the affected rows back).
  ```bash
  az postgres flexible-server restore --resource-group <rg> --source-server <server> \
    --name <server>-restore --restore-time "2026-10-18T13:00:00Z"
  ```
- **Postgres, from the vault** (server gone, or older than 35 days): Portal → Backup vault → Backup instances → the server → Restore → *Restore as files* → container `pg-restores`. Load the dump files into a new flexible server with `pg_restore --no-owner`. Errors about `azure_pg_admin`/`azuresu` roles are expected and safe to ignore.
- **A deleted or overwritten blob** (nail photo, swatch): Portal → container → *Show deleted blobs* → Undelete, or the blob → *Versions* → make a previous version current. CLI: `az storage blob undelete --account-name <acct> -c nail-photos -n <blob> --auth-mode login`.
- **A deleted container**: `az storage container restore --account-name <acct> --name nail-photos --deleted-version <version>` (find it with `az storage container list --include-deleted`).
- **Nail photos from the vault** (account gone or past 30 days): Portal → Backup vault → Backup instances → nail photos → Restore, to the same or another storage account.
- **Terraform state**: `az storage blob list --account-name <acct> -c tfstate --prefix <env>.terraform.tfstate --include v --auth-mode login` lists versions; copy the good version over the current blob (`az storage blob copy start --source-uri '<blob-url>?versionId=<id>'`).
- **Key Vault**: a deleted vault, `az keyvault recover --name <vault>`; a deleted secret, `az keyvault secret recover --vault-name <vault> --name <secret>`.

**Restore drill (quarterly, prod).** Do a point-in-time restore to a scratch server and compare row counts for `user_inventory_item`, `manicure` and `color_training_sample`. Undelete one test blob in `nail-photos`, and check that the vault's latest Postgres and blob backup jobs succeeded. Delete the scratch server afterwards.

## Naming Convention

```
${base_name}-${environment}-${resource_type}-${random_8char_suffix}
```

Example: `swatchwatch-dev-function-3fa1c9d2`

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
| `document_intelligence_name` | Document Intelligence account name (empty when disabled) |
| `document_intelligence_endpoint` | Document Intelligence endpoint URL (empty when disabled) |
| `openai_account_name` | Primary Azure OpenAI account name |
| `openai_account_names_by_region` | Map of OpenAI account names by region |
| `openai_endpoint` | Azure OpenAI endpoint URL |
| `openai_endpoints_by_region` | Map of OpenAI endpoints by region |
| `openai_hex_deployment_name` | Azure OpenAI deployment name used by Functions (empty when OpenAI is disabled) |
| `openai_diagnostic_setting_name` | Primary region Azure OpenAI diagnostic setting attached to Log Analytics |
| `openai_regions_provisioned` | List of regions where OpenAI accounts were provisioned/retained |
| `openai_resources_provisioned` | Whether this stack provisioned Azure OpenAI resources |
| `apim_name` | APIM service name (empty when `apim_enabled=false`) |
| `apim_gateway_url` | APIM gateway URL (empty when `apim_enabled=false`) |
| `openai_gateway_endpoint` | APIM OpenAI gateway base URL exposed to Functions via `AZURE_OPENAI_GATEWAY_ENDPOINT` |
| `application_insights_name` | Application Insights resource name |
| `application_insights_connection_string` | *(sensitive)* App Insights connection string, for the web build's `NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING` |
| `log_analytics_workspace_name` | Log Analytics workspace name |
| `key_vault_name` | Key Vault name |
| `github_client_id` | Azure AD app ID for GitHub Actions *(add to GitHub Secrets as `AZURE_CLIENT_ID`)* |
| `github_tenant_id` | Azure AD tenant ID *(add to GitHub Secrets as `AZURE_TENANT_ID`)* |
| `subscription_id` | Azure subscription ID *(add to GitHub Secrets as `AZURE_SUBSCRIPTION_ID`)* |

The bootstrap script displays these values at the end.

## Manual Deployment (without bootstrap script)

If you prefer manual control:

```bash
cd infrastructure

# Create an environment-specific tfvars file
cat > terraform.dev.tfvars <<EOF
subscription_id   = "your-azure-subscription-id"
environment       = "dev"
location          = "centralus"
github_repository = "your-github-username/swatchwatch"
pg_admin_username = "pgadmin"
pg_admin_password = "your-secure-password"
create_openai_resources = false
# openai_regions = ["centralus", "southcentralus", "eastus", "eastus2"]
EOF

# Initialize remote backend (example values)
TFSTATE_RESOURCE_GROUP="swatchwatch-dev-rg"
TFSTATE_STORAGE_ACCOUNT="swatchwatchdevj5jij0be"
TFSTATE_CONTAINER="tfstate"
TFSTATE_BLOB_NAME="dev.terraform.tfstate"

TFSTATE_ACCESS_KEY=$(az storage account keys list \
  --resource-group "$TFSTATE_RESOURCE_GROUP" \
  --account-name "$TFSTATE_STORAGE_ACCOUNT" \
  --query '[0].value' -o tsv)

az storage container create \
  --name "$TFSTATE_CONTAINER" \
  --account-name "$TFSTATE_STORAGE_ACCOUNT" \
  --account-key "$TFSTATE_ACCESS_KEY" \
  --output none

terraform init -reconfigure \
  -backend-config="resource_group_name=$TFSTATE_RESOURCE_GROUP" \
  -backend-config="storage_account_name=$TFSTATE_STORAGE_ACCOUNT" \
  -backend-config="container_name=$TFSTATE_CONTAINER" \
  -backend-config="key=$TFSTATE_BLOB_NAME" \
  -backend-config="access_key=$TFSTATE_ACCESS_KEY"

# Plan
terraform plan -var-file=terraform.dev.tfvars -out=tfplan.dev

# Apply
terraform apply tfplan.dev

# View outputs
terraform output
```

If you have a legacy `terraform.tfvars`, rename or remove it to avoid hidden overrides.

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
export PGDATABASE=swatchwatch
export PGUSER="pgadmin@$(cd ../infrastructure && terraform output -raw postgres_server_name)"
export PGPASSWORD="your-password"

npm run migrate
psql -h $PGHOST -U $PGUSER -d $PGDATABASE -f ../../docs/seed_data_sources.sql
```

### 3. Add Remaining Optional Secrets to Key Vault

```bash
VAULT_NAME=$(cd infrastructure && terraform output -raw key_vault_name)

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
    AZURE_SPEECH_KEY="@Microsoft.KeyVault(SecretUri=https://${VAULT_NAME}.vault.azure.net/secrets/azure-speech-key)"
```

OpenAI settings are optional:
- If `create_openai_resources=true`, Terraform provisions OpenAI account/deployment resources across `openai_regions` (or `openai_location` when `openai_regions` is empty; one of them is required, there is no `location` fallback, see [Azure OpenAI region and replacement guard](#azure-openai-region-and-replacement-guard)), wires `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_KEY` from the first region in that list, and sets `AZURE_OPENAI_DEPLOYMENT_HEX`/`AZURE_OPENAI_DEPLOYMENT_HEX_BATCH`. If `openai_batch_deployment_name` is set and differs from `openai_deployment_name`, Terraform also provisions `azurerm_cognitive_deployment.openai_hex_batch` in each managed region; otherwise batch detection reuses the sync deployment. Diagnostics flow to Log Analytics/Application Insights.
- If `create_openai_resources=false`, either:
  - set `openai_endpoint` + `openai_api_key`, or
  - set `openai_endpoint` + `openai_key_vault_secret_uri` (preferred).
- When `apim_enabled=true`, Terraform also provisions APIM (Consumption by default) and sets Function App gateway settings:
  - `AZURE_OPENAI_GATEWAY_ENDPOINT`
  - `AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY` (from `apim_openai_subscription_key_uri` when provided, otherwise from a Terraform-managed Key Vault secret created from `apim_openai_subscription_key`)
  - `AZURE_OPENAI_USE_GATEWAY` (controlled by `openai_gateway_enabled`, with Terraform validation to fail fast if gateway endpoint/secret wiring is incomplete)

## External ID service principal (opt-in)

The web sign-in app's enterprise app (service principal) in each External ID tenant can be managed by Terraform, starting with **Assignment required = No** (`app_role_assignment_required = false`). With it set to Yes, every new sign-up fails with AADSTS50105. Admin access is unaffected: it comes from the `admin` app role assignment, which still lands in the token's `roles` claim when assignment isn't required.

Only the service principal is managed (`azuread_service_principal.ciam_web`, imported by `azure_ad_b2c_client_id`). The app registration stays hand-managed. Everything except the assignment flag is in `ignore_changes`, and `prevent_destroy` stops a plan from deleting it, because deleting it would drop every app role assignment, `admin` included.

Deploy Infra authenticates to the CIAM tenant with GitHub OIDC, through a federated credential on a deployer app registration in that tenant. No client secret is involved. That app holds the **Cloud Application Administrator** directory role, the role External ID documents for managing apps in external tenants. A directory role assigned to a service principal applies to its app-only Graph calls, so it needs no Graph application permission on top. Graph application permissions haven't been tried in external tenants. `Application.ReadWrite.OwnedBy` would also need the deployer to be an owner of the web app's service principal (it has none today). `Application.ReadWrite.All` is about as broad as the role.

### One-time bootstrap (per environment)

Run as an admin of the External ID tenant who can assign directory roles (Global Administrator or Privileged Role Administrator). Example for `dev`; for prod use the prod tenant and `environment:prod`.

```bash
CIAM_TENANT_ID="<external ID tenant id>"        # dev: 2bff1c8d-f022-45ed-91bf-7485529ba989
WEB_CLIENT_ID="<azure_ad_b2c_client_id>"         # the web sign-in app
GH_ENV=dev
az login --tenant "$CIAM_TENANT_ID" --allow-no-subscriptions

# 0. Check the current setting first (prod: decide whether it should change).
az ad sp show --id "$WEB_CLIENT_ID" --query "{name:displayName,assignmentRequired:appRoleAssignmentRequired}"

# 1. Deployer app + service principal in the CIAM tenant.
DEPLOYER_APP_ID=$(az ad app create --display-name "swatchwatch-$GH_ENV-terraform-ciam" \
  --sign-in-audience AzureADMyOrg --query appId -o tsv)
DEPLOYER_SP_ID=$(az ad sp create --id "$DEPLOYER_APP_ID" --query id -o tsv)

# 2. Trust GitHub Actions OIDC for this repo + GitHub environment (same subject as the workforce app).
az ad app federated-credential create --id "$DEPLOYER_APP_ID" --parameters "{
  \"name\": \"github-actions-$GH_ENV\",
  \"issuer\": \"https://token.actions.githubusercontent.com\",
  \"subject\": \"repo:mattmck/swatchwatch:environment:$GH_ENV\",
  \"audiences\": [\"api://AzureADTokenExchange\"]
}"

# 3. Cloud Application Administrator (role template 158c047a-c907-4556-b7ef-446551a6b5f7), tenant scope.
az rest --method POST \
  --url https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments \
  --body "{\"principalId\":\"$DEPLOYER_SP_ID\",\"roleDefinitionId\":\"158c047a-c907-4556-b7ef-446551a6b5f7\",\"directoryScopeId\":\"/\"}"

echo "CIAM_TERRAFORM_CLIENT_ID=$DEPLOYER_APP_ID"
```

Then in the GitHub environment (`dev` or `prod`):

1. Set variables `CIAM_TENANT_ID` and `CIAM_TERRAFORM_CLIENT_ID`. Check that the `AZURE_AD_B2C_CLIENT_ID` secret is the real web client id: a precondition fails the plan if either id isn't a GUID.
2. Set `MANAGE_CIAM_SERVICE_PRINCIPAL=true`.
3. Run **Deploy Infra** with `apply = false`. The plan should show `azuread_service_principal.ciam_web[0]` with `1 to import` and only `app_role_assignment_required = true -> false` changed (or no change if it is already `false`). Then rerun with `apply = true`.

To plan locally instead, leave `ciam_terraform_client_id` empty so the `azuread.ciam` provider uses your Azure CLI login (`az login --tenant <ciam tenant> --allow-no-subscriptions`):

```bash
terraform plan -target=azuread_service_principal.ciam_web -lock=false \
  -var-file=terraform.dev.tfvars \
  -var manage_ciam_service_principal=true \
  -var ciam_tenant_id="$CIAM_TENANT_ID" -var azure_ad_b2c_client_id="$WEB_CLIENT_ID"
```

**To stop managing it**, first take it out of state without deleting it, using `terraform state rm 'azuread_service_principal.ciam_web[0]'` or a `removed { from = azuread_service_principal.ciam_web, lifecycle { destroy = false } }` block. Then set `MANAGE_CIAM_SERVICE_PRINCIPAL=false`. Turning the flag off first makes the plan fail on `prevent_destroy`.

## Destroying Infrastructure

```bash
cd infrastructure
terraform destroy -var-file=terraform.dev.tfvars
```

**Warning:** This permanently deletes all data, including this environment's Terraform state (the `tfstate` container lives in the storage account being destroyed). Key Vault secrets are soft-deleted (recoverable for 7 days).

In prod, destroy is blocked on purpose: the delete locks must be removed first, purge protection means the vault name stays reserved for the soft-delete window, and backup vault data stays in soft delete for 14 days after protection is stopped.

To completely purge:
```bash
az keyvault purge --name $(terraform output -raw key_vault_name)
```
