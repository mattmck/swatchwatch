terraform {
  required_version = ">= 1.5.0"

  backend "azurerm" {}

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.100"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 2.47"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
  }
}

data "azurerm_client_config" "current" {}

resource "random_string" "suffix" {
  length  = 8
  special = false
  upper   = false
}

locals {
  resource_prefix                      = "${var.base_name}-${var.environment}"
  unique_suffix                        = random_string.suffix.result
  openai_external_endpoint             = trimspace(var.openai_endpoint)
  openai_external_api_key              = trimspace(var.openai_api_key)
  openai_external_key_vault_secret_uri = trimspace(var.openai_key_vault_secret_uri)
  openai_create_resources              = var.create_openai_resources
  openai_uses_external_inline_key = (
    local.openai_external_endpoint != "" &&
    local.openai_external_api_key != ""
  )
  openai_uses_external_secret_uri = (
    local.openai_external_endpoint != "" &&
    local.openai_external_key_vault_secret_uri != ""
  )
  openai_enabled = (
    local.openai_create_resources ||
    local.openai_uses_external_inline_key ||
    local.openai_uses_external_secret_uri
  )
  # AIServices kind returns a cognitiveservices.azure.com endpoint, but we need
  # the openai.azure.com endpoint for the Azure OpenAI SDK. Construct it from
  # the custom subdomain name instead.
  openai_endpoint_value = (
    local.openai_create_resources
    ? "https://${try(azurerm_cognitive_account.openai[0].custom_subdomain_name, "")}.openai.azure.com/"
    : local.openai_external_endpoint
  )
  openai_deployment_name_value = local.openai_enabled ? var.openai_deployment_name : ""
  openai_key_secret_value = (
    local.openai_create_resources
    ? try(azurerm_cognitive_account.openai[0].primary_access_key, "")
    : local.openai_external_api_key
  )
  openai_key_secret_uri = (
    local.openai_uses_external_secret_uri
    ? local.openai_external_key_vault_secret_uri
    : try(azurerm_key_vault_secret.openai_key[0].versionless_id, "")
  )
}

check "openai_configuration" {
  assert {
    condition = (
      var.create_openai_resources ||
      (
        (
          trimspace(var.openai_endpoint) == "" &&
          trimspace(var.openai_api_key) == "" &&
          trimspace(var.openai_key_vault_secret_uri) == ""
        ) ||
        (
          trimspace(var.openai_endpoint) != "" &&
          (
            trimspace(var.openai_api_key) != "" ||
            trimspace(var.openai_key_vault_secret_uri) != ""
          )
        )
      )
    )
    error_message = "When create_openai_resources is false, set openai_endpoint with either openai_api_key or openai_key_vault_secret_uri, or leave all three empty."
  }
}

# ── Resource Group ──────────────────────────────────────────────

resource "azurerm_resource_group" "main" {
  name     = "${local.resource_prefix}-rg"
  location = var.location
}

# ── Azure Key Vault ─────────────────────────────────────────────

resource "azurerm_key_vault" "main" {
  name                = "kv${var.base_name}${var.environment}${local.unique_suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"

  purge_protection_enabled   = false # Set true for production
  soft_delete_retention_days = 7

  enable_rbac_authorization = false # Using access policies for simplicity
}



# Grant your current user full access to Key Vault (skip in CI — the
# github_actions policy covers the service principal instead).
resource "azurerm_key_vault_access_policy" "deployer" {
  count        = var.is_automation ? 0 : 1
  key_vault_id = azurerm_key_vault.main.id
  tenant_id    = data.azurerm_client_config.current.tenant_id
  object_id    = data.azurerm_client_config.current.object_id

  key_permissions = [
    "Get", "List", "Update", "Create", "Import", "Delete", "Recover", "Backup", "Restore", "Purge"
  ]

  secret_permissions = [
    "Get", "List", "Set", "Delete", "Purge", "Recover"
  ]

  certificate_permissions = [
    "Get", "List", "Update", "Create", "Import", "Delete", "Recover", "Backup", "Restore", "Purge", "ManageContacts", "ManageIssuers", "GetIssuers", "ListIssuers", "SetIssuers", "DeleteIssuers"
  ]
}

# Store Postgres password in Key Vault
resource "azurerm_key_vault_secret" "pg_password" {
  name         = "pg-password"
  value        = var.pg_admin_password
  key_vault_id = azurerm_key_vault.main.id
  depends_on = [
    azurerm_key_vault_access_policy.deployer,
    azurerm_key_vault_access_policy.github_actions,
  ]
}

# ── Azure Database for PostgreSQL Flexible Server ───────────────

resource "azurerm_postgresql_flexible_server" "main" {
  name                = "${local.resource_prefix}-pg-${local.unique_suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  version             = "16"

  administrator_login    = var.pg_admin_username
  administrator_password = var.pg_admin_password

  sku_name   = "B_Standard_B1ms"
  storage_mb = 32768

  backup_retention_days        = 7
  geo_redundant_backup_enabled = false

  zone = "1"
}

resource "azurerm_postgresql_flexible_server_database" "main" {
  name      = "swatchwatch"
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_postgresql_flexible_server_configuration" "pg_trgm" {
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "pg_trgm,vector"
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "allow_azure_services" {
  name             = "AllowAzureServices"
  server_id        = azurerm_postgresql_flexible_server.main.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

# ── Storage Account (polish images) ────────────────────────────

resource "azurerm_storage_account" "main" {
  name                            = "${var.base_name}${var.environment}${local.unique_suffix}"
  resource_group_name             = azurerm_resource_group.main.name
  location                        = azurerm_resource_group.main.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  allow_nested_items_to_be_public = false
}

resource "azurerm_storage_container" "swatches" {
  name                  = "swatches"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

resource "azurerm_storage_container" "nail_photos" {
  name                  = "nail-photos"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

resource "azurerm_storage_container" "tfstate" {
  name                  = "tfstate"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

# ── Monitoring (Application Insights + Log Analytics) ──────────

resource "azurerm_log_analytics_workspace" "main" {
  name                = "${local.resource_prefix}-law-${local.unique_suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_application_insights" "main" {
  name                = "${local.resource_prefix}-appi-${local.unique_suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  application_type    = "web"
  workspace_id        = azurerm_log_analytics_workspace.main.id
}

# ── Azure Functions (Consumption/Serverless) ────────────────────

resource "azurerm_service_plan" "main" {
  name                = "${local.resource_prefix}-plan"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = "Y1"
}

resource "azurerm_linux_function_app" "main" {
  name                = "${local.resource_prefix}-func-${local.unique_suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  service_plan_id     = azurerm_service_plan.main.id

  storage_account_name       = azurerm_storage_account.main.name
  storage_account_access_key = azurerm_storage_account.main.primary_access_key

  identity {
    type = "SystemAssigned"
  }

  site_config {
    application_insights_connection_string = azurerm_application_insights.main.connection_string
    application_insights_key               = azurerm_application_insights.main.instrumentation_key

    application_stack {
      node_version = "20"
    }

    cors {
      allowed_origins = [
        "https://jolly-desert-0c7f01510.2.azurestaticapps.net",
        "https://dev.${var.domain_name}",
        "http://localhost:3000",
      ]
      support_credentials = false
    }
  }

  app_settings = {
    FUNCTIONS_WORKER_RUNTIME    = "node"
    FUNCTIONS_EXTENSION_VERSION = "~4"
    PGHOST                      = azurerm_postgresql_flexible_server.main.fqdn
    PGPORT                      = "5432"
    PGDATABASE                  = azurerm_postgresql_flexible_server_database.main.name
    PGUSER                      = var.pg_admin_username
    # Reference Key Vault secret instead of plaintext password
    PGPASSWORD = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.pg_password.versionless_id})"
    # Placeholder for future secrets
    AZURE_STORAGE_CONNECTION    = azurerm_storage_account.main.primary_connection_string
    INGESTION_JOB_QUEUE_NAME    = "ingestion-jobs"
    AZURE_SPEECH_KEY            = "to-be-added"
    AZURE_SPEECH_REGION         = azurerm_resource_group.main.location
    AZURE_OPENAI_ENDPOINT       = local.openai_enabled ? local.openai_endpoint_value : ""
    AZURE_OPENAI_KEY            = local.openai_enabled ? "@Microsoft.KeyVault(SecretUri=${local.openai_key_secret_uri})" : ""
    AZURE_OPENAI_DEPLOYMENT_HEX = local.openai_deployment_name_value,
    AZURE_AD_B2C_TENANT         = "to-be-added",
    AZURE_AD_B2C_CLIENT_ID      = "to-be-added",
    AUTH_DEV_BYPASS             = "true"
  }

  lifecycle {
    ignore_changes = [
      app_settings["WEBSITE_RUN_FROM_PACKAGE"],
      app_settings["WEBSITE_MOUNT_ENABLED"],
      tags["hidden-link: /app-insights-resource-id"],
      tags["hidden-link: /app-insights-instrumentation-key"],
      tags["hidden-link: /app-insights-conn-string"],
    ]
  }
}

# Grant Function App access to Key Vault
resource "azurerm_key_vault_access_policy" "function_app" {
  key_vault_id = azurerm_key_vault.main.id
  tenant_id    = data.azurerm_client_config.current.tenant_id
  object_id    = azurerm_linux_function_app.main.identity[0].principal_id

  secret_permissions = ["Get", "List"]
}

# ── Static Web App (Next.js frontend) ──────────────────────────

resource "azurerm_static_web_app" "main" {
  name                = "${local.resource_prefix}-web"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku_tier            = "Standard"
  sku_size            = "Standard"

  app_settings = {
    NEXT_PUBLIC_API_URL = "https://${azurerm_linux_function_app.main.default_hostname}/api"
  }
}

resource "azurerm_static_web_app_custom_domain" "dev" {
  static_web_app_id = azurerm_static_web_app.main.id
  domain_name       = "dev.${var.domain_name}"
  validation_type   = "cname-delegation"

  lifecycle {
    ignore_changes = [validation_type]
  }
}

# ── Azure Speech Services ──────────────────────────────────────
# Azure AD B2C is provisioned separately via the portal

resource "azurerm_cognitive_account" "speech" {
  name                = "${local.resource_prefix}-speech"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  kind                = "SpeechServices"
  sku_name            = "S0"
}

resource "azurerm_cognitive_account" "openai" {
  count                 = (local.openai_create_resources || var.retain_openai_account) ? 1 : 0
  name                  = "${local.resource_prefix}-openai-${local.unique_suffix}"
  resource_group_name   = azurerm_resource_group.main.name
  location              = var.openai_location != null ? var.openai_location : azurerm_resource_group.main.location
  kind                  = "OpenAI"
  sku_name              = "S0"
  custom_subdomain_name = var.openai_custom_subdomain_name != null ? var.openai_custom_subdomain_name : "${local.resource_prefix}-openai-${local.unique_suffix}"

  # Azure auto-migrated the resource from kind "OpenAI" to "AIServices".
  # The azurerm v3 provider doesn't support "AIServices", so ignore the drift
  # to prevent a destructive replacement. Also ignore immutable location/
  # subdomain drift while retaining this legacy account in Terraform.
  # Remove this after upgrading to v4 and decommissioning the legacy account.
  lifecycle {
    ignore_changes = [
      kind,
      location,
      custom_subdomain_name,
      tags,
    ]
  }
}

resource "azurerm_cognitive_deployment" "openai_hex" {
  count                = local.openai_create_resources ? 1 : 0
  name                 = var.openai_deployment_name
  cognitive_account_id = azurerm_cognitive_account.openai[0].id

  model {
    format  = "OpenAI"
    name    = var.openai_model_name
    version = var.openai_model_version
  }

  scale {
    type     = "Standard"
    capacity = var.openai_deployment_capacity
  }
}

# Send Azure OpenAI diagnostics to the shared Log Analytics workspace
# (same workspace backing Application Insights).
resource "azurerm_monitor_diagnostic_setting" "openai" {
  count                      = local.openai_create_resources ? 1 : 0
  name                       = "openai-observability"
  target_resource_id         = azurerm_cognitive_account.openai[0].id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category_group = "allLogs"
  }

  metric {
    category = "AllMetrics"
    enabled  = true
  }
}

resource "azurerm_key_vault_secret" "openai_key" {
  count        = (local.openai_create_resources || local.openai_uses_external_inline_key) ? 1 : 0
  name         = "azure-openai-key"
  value        = local.openai_key_secret_value
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [
    azurerm_key_vault_access_policy.deployer,
    azurerm_key_vault_access_policy.github_actions,
  ]
}

# ── GitHub Actions OIDC Federation (passwordless CI/CD) ────────

resource "azuread_application" "github_actions" {
  display_name = "${var.base_name}-${var.environment}-github-actions"
}

resource "azuread_service_principal" "github_actions" {
  client_id = azuread_application.github_actions.client_id
}

# Federated credential for GitHub Actions OIDC
resource "azuread_application_federated_identity_credential" "github_actions" {
  application_id = azuread_application.github_actions.id
  display_name   = "github-actions-${var.environment}"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = "repo:${var.github_repository}:environment:${var.environment}"
}

# Grant GitHub Actions service principal Contributor access
resource "azurerm_role_assignment" "github_contributor" {
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Contributor"
  principal_id         = azuread_service_principal.github_actions.object_id
}

# Grant GitHub Actions service principal Cognitive Services Contributor access
resource "azurerm_role_assignment" "github_cognitive_services_contributor" {
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Cognitive Services Contributor"
  principal_id         = azuread_service_principal.github_actions.object_id
}

# Grant GitHub Actions access to Key Vault
resource "azurerm_key_vault_access_policy" "github_actions" {
  key_vault_id = azurerm_key_vault.main.id
  tenant_id    = data.azurerm_client_config.current.tenant_id
  object_id    = azuread_service_principal.github_actions.object_id

  secret_permissions = ["Get", "List", "Set", "Delete", "Purge"]
}
