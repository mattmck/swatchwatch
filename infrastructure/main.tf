terraform {
  required_version = ">= 1.7.0"

  backend "azurerm" {}

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.50"
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
  subscription_id = var.subscription_id
  features {
    key_vault {
      # Prod keeps soft-deleted vaults recoverable (and purge protection blocks
      # the purge anyway); dev purges on destroy so a re-create can reuse names.
      purge_soft_delete_on_destroy    = var.environment != "prod"
      recover_soft_deleted_key_vaults = true
    }
  }
}

data "azurerm_client_config" "current" {}

# Entra External ID (CIAM) tenant that hosts the web sign-in app. Used only
# when manage_ciam_service_principal = true; otherwise it falls back to the
# default credentials and nothing is read through it. In Deploy Infra it
# signs in with GitHub OIDC to a deployer app registration in the CIAM tenant
# (ciam_terraform_client_id, federated credential, no secret); locally, leave
# that empty and use `az login --tenant <ciam tenant> --allow-no-subscriptions`.
# Bootstrap: infrastructure/README.md, "External ID service principal".
provider "azuread" {
  alias     = "ciam"
  tenant_id = var.manage_ciam_service_principal ? var.ciam_tenant_id : null
  client_id = local.ciam_use_oidc ? var.ciam_terraform_client_id : null
  use_oidc  = local.ciam_use_oidc
}

resource "random_string" "suffix" {
  length  = 8
  special = false
  upper   = false
}

locals {
  resource_prefix = "${var.base_name}-${var.environment}"
  unique_suffix   = random_string.suffix.result
  # GitHub OIDC to the CIAM deployer app; empty client id = Azure CLI (local).
  ciam_use_oidc = var.manage_ciam_service_principal && var.ciam_terraform_client_id != ""
  web_app_origins = (
    var.environment == "prod"
    ? ["https://${var.domain_name}", "https://www.${var.domain_name}"]
    : ["https://dev.${var.domain_name}"]
  )
  function_cors_allowed_origins = concat(
    local.web_app_origins,
    var.environment == "prod" ? [] : ["http://localhost:3000"],
    ["https://*.azurestaticapps.net"]
  )
  appinsights_daily_cap_gb = coalesce(
    var.appinsights_daily_cap_gb,
    try(var.appinsights_daily_cap_gb_defaults[var.environment], var.appinsights_daily_cap_gb_defaults["dev"], 0.5)
  )
  alerts_enabled                       = coalesce(var.alerts_enabled, var.environment == "prod")
  backup_vault_enabled                 = coalesce(var.backup_vault_enabled, var.environment == "prod")
  delete_locks_enabled                 = coalesce(var.delete_locks_enabled, var.environment == "prod")
  alert_email                          = trimspace(var.alert_email)
  static_web_app_custom_domain_name    = var.environment == "prod" ? var.domain_name : "dev.${var.domain_name}"
  static_web_app_validation_method     = var.environment == "prod" ? "dns-txt-token" : "cname-delegation"
  key_vault_name_prefix                = lower(replace("${var.base_name}${var.environment}", "/[^0-9a-z]/", ""))
  key_vault_name                       = "kv${substr(local.key_vault_name_prefix, 0, 14)}${local.unique_suffix}"
  openai_external_endpoint             = trimspace(var.openai_endpoint)
  openai_external_api_key              = trimspace(var.openai_api_key)
  openai_external_key_vault_secret_uri = trimspace(var.openai_key_vault_secret_uri)
  openai_create_resources              = var.create_openai_resources
  openai_regions_normalized = distinct([
    for region in var.openai_regions : lower(trimspace(region))
    if trimspace(region) != ""
  ])
  openai_location_trimmed = (
    var.openai_location != null && trimspace(var.openai_location) != ""
    ? lower(trimspace(var.openai_location))
    : null
  )
  # True when the OpenAI region was set explicitly (openai_regions or
  # openai_location). The `location` fallback below only keeps the locals
  # evaluable; azurerm_cognitive_account.openai refuses to plan without an
  # explicit region (see its precondition), because a guessed region moves
  # the account and soft-deletes it with every deployment.
  openai_region_explicit = (
    length(local.openai_regions_normalized) > 0 || local.openai_location_trimmed != null
  )
  openai_primary_region_fallback = coalesce(local.openai_location_trimmed, lower(trimspace(var.location)))
  openai_target_regions = (
    length(local.openai_regions_normalized) > 0
    ? local.openai_regions_normalized
    : [local.openai_primary_region_fallback]
  )
  openai_primary_region_key = local.openai_target_regions[0]
  openai_managed_regions = (
    local.openai_create_resources
    ? local.openai_target_regions
    : []
  )
  openai_region_slug_by_region = {
    for region in local.openai_managed_regions :
    region => replace(region, "/[^0-9a-z]/", "")
  }
  openai_account_name_by_region = {
    for region in local.openai_managed_regions :
    region => (
      region == local.openai_primary_region_key
      ? "${local.resource_prefix}-openai-${local.unique_suffix}"
      : "${local.resource_prefix}-openai-${local.openai_region_slug_by_region[region]}-${local.unique_suffix}"
    )
  }
  openai_custom_subdomain_default = "${local.resource_prefix}-openai-${local.unique_suffix}"
  openai_custom_subdomain_name_trimmed = (
    var.openai_custom_subdomain_name != null && try(trimspace(var.openai_custom_subdomain_name), "") != ""
    ? trimspace(var.openai_custom_subdomain_name)
    : null
  )
  openai_custom_subdomain_by_region = {
    for region in local.openai_managed_regions :
    region => (
      region == local.openai_primary_region_key
      ? coalesce(local.openai_custom_subdomain_name_trimmed, local.openai_custom_subdomain_default)
      : "${local.resource_prefix}-openai-${local.openai_region_slug_by_region[region]}-${local.unique_suffix}"
    )
  }
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
    ? "https://${try(azurerm_cognitive_account.openai[local.openai_primary_region_key].custom_subdomain_name, "")}.openai.azure.com/"
    : local.openai_external_endpoint
  )
  openai_deployment_name_value         = local.openai_enabled ? var.openai_deployment_name : ""
  openai_batch_deployment_name_trimmed = trimspace(var.openai_batch_deployment_name)
  openai_batch_deployment_name_value = (
    local.openai_enabled
    ? (
      local.openai_batch_deployment_name_trimmed != ""
      ? local.openai_batch_deployment_name_trimmed
      : var.openai_deployment_name
    )
    : ""
  )
  openai_batch_model_name_value = (
    trimspace(var.openai_batch_model_name) != ""
    ? trimspace(var.openai_batch_model_name)
    : var.openai_model_name
  )
  openai_batch_model_version_value = (
    trimspace(var.openai_batch_model_version) != ""
    ? trimspace(var.openai_batch_model_version)
    : var.openai_model_version
  )
  openai_batch_deployment_managed = (
    local.openai_create_resources &&
    local.openai_batch_deployment_name_trimmed != "" &&
    local.openai_batch_deployment_name_trimmed != var.openai_deployment_name
  )
  openai_key_secret_value = (
    local.openai_create_resources
    ? try(azurerm_cognitive_account.openai[local.openai_primary_region_key].primary_access_key, "")
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
  name                = local.key_vault_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"

  # Purge protection is one-way: once enabled it can't be turned off, and a
  # deleted prod vault (with IMAGE_PROXY_SIGNING_KEY, which wishlist share
  # tokens and signed image ids derive from) stays recoverable for the full
  # soft-delete window. The retention window can only be set at vault creation.
  purge_protection_enabled   = var.environment == "prod"
  soft_delete_retention_days = 7

  rbac_authorization_enabled = false # Using access policies for simplicity
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

# HMAC key for signed /api/images/{id} capability URLs (see packages/functions/src/lib/image-proxy.ts).
# Rotating it (terraform taint / replace) invalidates previously issued image URLs.
resource "random_password" "image_proxy_signing_key" {
  length  = 64
  special = false
}

resource "azurerm_key_vault_secret" "image_proxy_signing_key" {
  name         = "image-proxy-signing-key"
  value        = random_password.image_proxy_signing_key.result
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

  # Built-in point-in-time restore. Weekly long-term copies that survive the
  # server being deleted live in the backup vault (see "Backups" below).
  backup_retention_days        = var.pg_backup_retention_days
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

  # Recovery from accidental deletes/overwrites. Versioning also keeps prior
  # Terraform state versions (the tfstate container below is the live remote
  # state backend). Change feed is required by the vaulted blob backup's object
  # replication; Azure Backup would otherwise enable it out of band.
  blob_properties {
    versioning_enabled            = true
    change_feed_enabled           = true
    change_feed_retention_in_days = 7

    delete_retention_policy {
      days = var.blob_soft_delete_retention_days
    }

    container_delete_retention_policy {
      days = var.blob_soft_delete_retention_days
    }
  }
}

# Expire old blob versions so versioning doesn't grow storage without bound.
resource "azurerm_storage_management_policy" "main" {
  storage_account_id = azurerm_storage_account.main.id

  rule {
    name    = "expire-media-versions"
    enabled = true
    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["${azurerm_storage_container.swatches.name}/", "${azurerm_storage_container.nail_photos.name}/"]
    }
    actions {
      version {
        delete_after_days_since_creation = var.blob_version_retention_days
      }
    }
  }

  rule {
    name    = "expire-tfstate-versions"
    enabled = true
    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["${azurerm_storage_container.tfstate.name}/"]
    }
    actions {
      version {
        delete_after_days_since_creation = var.tfstate_version_retention_days
      }
    }
  }

  # Connector snapshots/catalog cache are regenerable and rewritten often.
  rule {
    name    = "expire-connector-raw-versions"
    enabled = true
    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["${azurerm_storage_container.connector_raw.name}/"]
    }
    actions {
      version {
        delete_after_days_since_creation = 7
      }
    }
  }

  # Postgres vault restores land here as dump files; they're scratch copies.
  rule {
    name    = "expire-pg-restores"
    enabled = true
    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["pg-restores/"]
    }
    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = 14
      }
      version {
        delete_after_days_since_creation = 1
      }
    }
  }
}

resource "azurerm_storage_container" "swatches" {
  name                  = "swatches"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

resource "azurerm_storage_container" "nail_photos" {
  name                  = "nail-photos"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

# Live Terraform remote state for this environment (the azurerm backend points
# here). Never remove: deleting it deletes the state.
resource "azurerm_storage_container" "tfstate" {
  name                  = "tfstate"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

resource "azurerm_storage_container" "connector_raw" {
  name                  = "connector-raw"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

# ── Backups (Azure Backup vault) ───────────────────────────────
# Off-resource copies that survive the source being deleted: weekly logical
# backups of the whole Postgres server and daily vaulted backups of the
# nail-photos container (private user media, the only copy). Locally redundant
# by design. Prod only by default (backup_vault_enabled).
#
# The vault's managed identity needs role assignments, which the CI service
# principal (Contributor) can't create: the first apply that enables this must
# be run locally by someone with User Access Administrator (as for bootstrap).
#
# Retention values feed backup policies, and changing a policy forces Azure to
# replace it, which fails while an instance uses it. To change retention, add
# a new policy, point the instance at it, then remove the old one.

resource "azurerm_data_protection_backup_vault" "main" {
  count               = local.backup_vault_enabled ? 1 : 0
  name                = "${local.resource_prefix}-bv-${local.unique_suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  datastore_type      = "VaultStore"
  redundancy          = "LocallyRedundant"

  # Deleted backup data is kept 14 more days; recovery points can't be
  # deleted before they expire. "Unlocked" can still be turned off; switching
  # to "Locked" is irreversible.
  soft_delete                = "On"
  retention_duration_in_days = 14
  immutability               = "Unlocked"

  identity {
    type = "SystemAssigned"
  }
}

resource "azurerm_role_assignment" "backup_vault_reader" {
  count                = local.backup_vault_enabled ? 1 : 0
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Reader"
  principal_id         = azurerm_data_protection_backup_vault.main[0].identity[0].principal_id
}

resource "azurerm_role_assignment" "backup_vault_postgres" {
  count                = local.backup_vault_enabled ? 1 : 0
  scope                = azurerm_postgresql_flexible_server.main.id
  role_definition_name = "PostgreSQL Flexible Server Long Term Retention Backup Role"
  principal_id         = azurerm_data_protection_backup_vault.main[0].identity[0].principal_id
}

resource "azurerm_role_assignment" "backup_vault_storage" {
  count                = local.backup_vault_enabled ? 1 : 0
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Account Backup Contributor"
  principal_id         = azurerm_data_protection_backup_vault.main[0].identity[0].principal_id
}

# Postgres vault backups restore only as dump files into a container; this is
# the pre-wired target (expired after 14 days by the management policy).
resource "azurerm_storage_container" "pg_restores" {
  count                 = local.backup_vault_enabled ? 1 : 0
  name                  = "pg-restores"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

resource "azurerm_role_assignment" "backup_vault_pg_restores" {
  count                = local.backup_vault_enabled ? 1 : 0
  scope                = azurerm_storage_container.pg_restores[0].id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_data_protection_backup_vault.main[0].identity[0].principal_id
}

# Weekly (the only frequency the vault supports for Postgres), Sundays 07:00 UTC.
resource "azurerm_data_protection_backup_policy_postgresql_flexible_server" "weekly" {
  count                           = local.backup_vault_enabled ? 1 : 0
  name                            = "postgres-weekly"
  vault_id                        = azurerm_data_protection_backup_vault.main[0].id
  backup_repeating_time_intervals = ["R/2026-10-18T07:00:00+00:00/P1W"]

  default_retention_rule {
    life_cycle {
      duration        = var.pg_vault_backup_retention
      data_store_type = "VaultStore"
    }
  }

  retention_rule {
    name     = "monthly"
    priority = 25

    criteria {
      absolute_criteria = "FirstOfMonth"
    }

    life_cycle {
      duration        = var.vault_backup_monthly_retention
      data_store_type = "VaultStore"
    }
  }
}

resource "azurerm_data_protection_backup_instance_postgresql_flexible_server" "main" {
  count            = local.backup_vault_enabled ? 1 : 0
  name             = "${azurerm_postgresql_flexible_server.main.name}-backup"
  location         = azurerm_resource_group.main.location
  vault_id         = azurerm_data_protection_backup_vault.main[0].id
  server_id        = azurerm_postgresql_flexible_server.main.id
  backup_policy_id = azurerm_data_protection_backup_policy_postgresql_flexible_server.weekly[0].id

  depends_on = [
    azurerm_role_assignment.backup_vault_reader,
    azurerm_role_assignment.backup_vault_postgres,
  ]
}

# Daily at 06:00 UTC.
resource "azurerm_data_protection_backup_policy_blob_storage" "nail_photos" {
  count                            = local.backup_vault_enabled ? 1 : 0
  name                             = "nail-photos-daily"
  vault_id                         = azurerm_data_protection_backup_vault.main[0].id
  backup_repeating_time_intervals  = ["R/2026-10-18T06:00:00+00:00/P1D"]
  vault_default_retention_duration = var.nail_photo_vault_backup_retention

  retention_rule {
    name     = "monthly"
    priority = 25

    criteria {
      absolute_criteria = "FirstOfMonth"
    }

    life_cycle {
      duration        = var.vault_backup_monthly_retention
      data_store_type = "VaultStore"
    }
  }
}

resource "azurerm_data_protection_backup_instance_blob_storage" "nail_photos" {
  count                           = local.backup_vault_enabled ? 1 : 0
  name                            = "${azurerm_storage_account.main.name}-nail-photos"
  location                        = azurerm_resource_group.main.location
  vault_id                        = azurerm_data_protection_backup_vault.main[0].id
  storage_account_id              = azurerm_storage_account.main.id
  backup_policy_id                = azurerm_data_protection_backup_policy_blob_storage.nail_photos[0].id
  storage_account_container_names = [azurerm_storage_container.nail_photos.name]

  depends_on = [
    azurerm_role_assignment.backup_vault_reader,
    azurerm_role_assignment.backup_vault_storage,
  ]
}

# ── Delete locks ───────────────────────────────────────────────
# CanNotDelete locks on the data stores (prod only by default). They block
# deletes from Terraform, the portal and the CLI alike, including deleting
# child resources such as storage containers or Postgres firewall rules:
# remove the lock first (Owner / User Access Administrator) when that's
# intended. The storage account also holds the live Terraform state.

locals {
  delete_locked_resources = local.delete_locks_enabled ? merge(
    {
      postgres = azurerm_postgresql_flexible_server.main.id
      storage  = azurerm_storage_account.main.id
    },
    # Splat, not [0]: in a refresh-only or -target run the vault may not be in
    # state yet, and indexing the empty tuple fails even when it is enabled
    # (Deploy Prod run 39183078392). The splat is empty until the vault exists.
    { for id in azurerm_data_protection_backup_vault.main[*].id : "backup_vault" => id }
  ) : {}
}

resource "azurerm_management_lock" "data" {
  for_each   = local.delete_locked_resources
  name       = "${each.key}-do-not-delete"
  scope      = each.value
  lock_level = "CanNotDelete"
  notes      = "Holds user data, backups or Terraform state. Remove this lock deliberately before deleting."
}

# ── Monitoring (Application Insights + Log Analytics) ──────────

resource "azurerm_log_analytics_workspace" "main" {
  name                = "${local.resource_prefix}-law-${local.unique_suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  # Cost guard: also covers Azure OpenAI diagnostics sent to this workspace.
  daily_quota_gb = local.appinsights_daily_cap_gb
}

resource "azurerm_application_insights" "main" {
  name                 = "${local.resource_prefix}-appi-${local.unique_suffix}"
  resource_group_name  = azurerm_resource_group.main.name
  location             = azurerm_resource_group.main.location
  application_type     = "web"
  workspace_id         = azurerm_log_analytics_workspace.main.id
  daily_data_cap_in_gb = local.appinsights_daily_cap_gb
}

# ── Alerts + availability (observability Phase 3, #281) ────────
# Prod only by default (D16). Everything here is gated by local.alerts_enabled.

locals {
  availability_tests = {
    web = {
      description = "Web home page"
      url         = "https://${local.static_web_app_custom_domain_name}/"
    }
    api = {
      description = "Anonymous API read (GET /api/reference/finishes)"
      url         = "https://${azurerm_linux_function_app.main.default_hostname}/api/reference/finishes"
    }
  }
}

check "alert_email_configuration" {
  assert {
    condition     = !local.alerts_enabled || local.alert_email != ""
    error_message = "alerts_enabled is true but alert_email is empty: alerts will fire in the portal but nobody is emailed. Set the ALERT_EMAIL GitHub environment secret (or variable)."
  }
}

resource "azurerm_monitor_action_group" "main" {
  count               = local.alerts_enabled ? 1 : 0
  name                = "${local.resource_prefix}-ag-${local.unique_suffix}"
  resource_group_name = azurerm_resource_group.main.name
  short_name          = substr("sw-${var.environment}", 0, 12)

  dynamic "email_receiver" {
    for_each = local.alert_email != "" ? [local.alert_email] : []
    content {
      name                    = "owner"
      email_address           = email_receiver.value
      use_common_alert_schema = true
    }
  }
}

# Server errors only: requests/failed also counts 4xx (401s from expired tokens,
# 404s), which would page on normal traffic. Each 5xx result code is its own series.
resource "azurerm_monitor_metric_alert" "api_5xx" {
  count               = local.alerts_enabled ? 1 : 0
  name                = "${local.resource_prefix}-alert-api-5xx-${local.unique_suffix}"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_application_insights.main.id]
  description         = "More than ${var.alert_api_5xx_threshold} Functions API 5xx responses in 5 minutes. Start at App Insights > Failures."
  severity            = 1
  frequency           = "PT1M"
  window_size         = "PT5M"

  criteria {
    metric_namespace = "microsoft.insights/components"
    metric_name      = "requests/failed"
    aggregation      = "Count"
    operator         = "GreaterThan"
    threshold        = var.alert_api_5xx_threshold

    dimension {
      name     = "request/resultCode"
      operator = "StartsWith"
      values   = ["5"]
    }
  }

  action {
    action_group_id = azurerm_monitor_action_group.main[0].id
  }
}

# Workspace-scoped so the query can use AppExceptions.ClientType: "Browser" rows
# come from the web SDK, everything else (ClientType "PC") from the Functions worker.
# Each result row is a client kind over its own threshold. sum(ItemCount), not
# count(): a sampled row (browser SDK sampling) stands for ItemCount exceptions.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "exception_spike" {
  count                = local.alerts_enabled ? 1 : 0
  name                 = "${local.resource_prefix}-alert-exceptions-${local.unique_suffix}"
  display_name         = "${local.resource_prefix} exception spike"
  description          = "Exceptions above threshold in 15 minutes (server > ${var.alert_server_exception_threshold}, browser > ${var.alert_browser_exception_threshold}). Split by ClientKind."
  resource_group_name  = azurerm_resource_group.main.name
  location             = azurerm_log_analytics_workspace.main.location
  scopes               = [azurerm_log_analytics_workspace.main.id]
  severity             = 2
  evaluation_frequency = "PT5M"
  window_duration      = "PT15M"

  criteria {
    query                   = <<-KQL
      AppExceptions
      | where _ResourceId =~ "${lower(azurerm_application_insights.main.id)}"
      | extend ClientKind = iff(ClientType == "Browser", "Browser", "Server")
      | summarize Exceptions = sum(ItemCount) by ClientKind
      | where Exceptions > iff(ClientKind == "Browser", ${var.alert_browser_exception_threshold}, ${var.alert_server_exception_threshold})
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

    dimension {
      name     = "ClientKind"
      operator = "Include"
      values   = ["*"]
    }

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  auto_mitigation_enabled = true

  action {
    action_groups = [azurerm_monitor_action_group.main[0].id]
  }
}

# markIngestionJobFailed() (packages/functions/src/lib/ingestion-repo.ts) emits
# the ingestion.job_failed custom event for every job the worker, the AI batch
# poller or the admin API marks failed.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "ingestion_failed" {
  count                = local.alerts_enabled ? 1 : 0
  name                 = "${local.resource_prefix}-alert-ingestion-${local.unique_suffix}"
  display_name         = "${local.resource_prefix} ingestion job failed"
  description          = "An ingestion job was marked failed. See /admin?tab=admin-jobs for the job log."
  resource_group_name  = azurerm_resource_group.main.name
  location             = azurerm_log_analytics_workspace.main.location
  scopes               = [azurerm_log_analytics_workspace.main.id]
  severity             = 2
  evaluation_frequency = "PT5M"
  window_duration      = "PT15M"

  criteria {
    query                   = <<-KQL
      AppEvents
      | where _ResourceId =~ "${lower(azurerm_application_insights.main.id)}"
      | where Name == "ingestion.job_failed"
      | project TimeGenerated, JobId = tostring(Properties.jobId), Error = tostring(Properties.error)
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  auto_mitigation_enabled = true

  action {
    action_groups = [azurerm_monitor_action_group.main[0].id]
  }
}

# The workspace logs "OverQuota" to _LogOperation (exempt from the cap) when its
# daily cap stops ingestion (D15). App Insights uses the same cap value.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "daily_cap" {
  count                = local.alerts_enabled ? 1 : 0
  name                 = "${local.resource_prefix}-alert-daily-cap-${local.unique_suffix}"
  display_name         = "${local.resource_prefix} telemetry daily cap reached"
  description          = "Log Analytics daily cap (${local.appinsights_daily_cap_gb} GB) reached: telemetry is dropped until the cap resets. Raise appinsights_daily_cap_gb if this is real traffic."
  resource_group_name  = azurerm_resource_group.main.name
  location             = azurerm_log_analytics_workspace.main.location
  scopes               = [azurerm_log_analytics_workspace.main.id]
  severity             = 2
  evaluation_frequency = "PT15M"
  window_duration      = "PT1H"

  criteria {
    query                   = <<-KQL
      _LogOperation
      | where Category =~ "Ingestion"
      | where Detail contains "OverQuota"
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  auto_mitigation_enabled = true

  action {
    action_groups = [azurerm_monitor_action_group.main[0].id]
  }
}

resource "azurerm_application_insights_standard_web_test" "availability" {
  for_each                = local.alerts_enabled ? local.availability_tests : {}
  name                    = "${local.resource_prefix}-webtest-${each.key}-${local.unique_suffix}"
  description             = each.value.description
  resource_group_name     = azurerm_resource_group.main.name
  location                = azurerm_application_insights.main.location
  application_insights_id = azurerm_application_insights.main.id
  geo_locations           = var.availability_test_locations
  frequency               = var.availability_test_frequency_seconds
  timeout                 = 30
  enabled                 = true
  retry_enabled           = true

  request {
    url = each.value.url
  }

  validation_rules {
    expected_status_code        = 200
    ssl_check_enabled           = true
    ssl_cert_remaining_lifetime = 7
  }
}

resource "azurerm_monitor_metric_alert" "availability" {
  for_each            = azurerm_application_insights_standard_web_test.availability
  name                = "${local.resource_prefix}-alert-availability-${each.key}-${local.unique_suffix}"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [each.value.id, azurerm_application_insights.main.id]
  description         = "${local.availability_tests[each.key].description} failing from 2+ locations: ${local.availability_tests[each.key].url}"
  severity            = 1
  frequency           = "PT1M"
  window_size         = "PT5M"

  application_insights_web_test_location_availability_criteria {
    web_test_id           = each.value.id
    component_id          = azurerm_application_insights.main.id
    failed_location_count = 2
  }

  action {
    action_group_id = azurerm_monitor_action_group.main[0].id
  }
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

    application_stack {
      node_version = "22"
    }

    # Keep this block. The Functions host reserves the CORS_ALLOWED_ORIGINS setting (it
    # JSON-parses it as the host CORS origin list); with platform CORS configured Azure supplies
    # that value itself, without it the host reads the app's comma-separated list below and fails
    # every request (2026-10-23 dev outage after #449). Platform CORS answers preflights and drops
    # the app's Access-Control-Expose-Headers until the app settings move to non-reserved names.
    cors {
      allowed_origins     = local.function_cors_allowed_origins
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
    AZURE_STORAGE_CONNECTION             = azurerm_storage_account.main.primary_connection_string
    INGESTION_JOB_QUEUE_NAME             = var.ingestion_job_queue_name
    CONNECTOR_RAW_CONTAINER              = azurerm_storage_container.connector_raw.name
    USER_MEDIA_CONTAINER                 = azurerm_storage_container.nail_photos.name
    AZURE_SPEECH_KEY                     = "to-be-added"
    AZURE_SPEECH_REGION                  = azurerm_resource_group.main.location
    AZURE_OPENAI_ENDPOINT                = local.openai_enabled ? local.openai_endpoint_value : ""
    AZURE_OPENAI_KEY                     = local.openai_enabled ? "@Microsoft.KeyVault(SecretUri=${local.openai_key_secret_uri})" : ""
    AZURE_OPENAI_DEPLOYMENT_HEX          = local.openai_deployment_name_value
    AZURE_OPENAI_DEPLOYMENT_HEX_BATCH    = local.openai_batch_deployment_name_value
    AZURE_OPENAI_BATCH_API_VERSION       = var.azure_openai_batch_api_version
    AZURE_OPENAI_BATCH_COMPLETION_WINDOW = var.azure_openai_batch_completion_window
    AZURE_OPENAI_VISION_DETAIL           = var.azure_openai_vision_detail
    HEX_DETECTION_BATCH_ENABLED          = var.hex_detection_batch_enabled ? "true" : "false"
    HEX_DETECTION_BATCH_MIN_IMAGES       = tostring(var.hex_detection_batch_min_images)
    HEX_DETECTION_SNAP_ENABLED           = var.hex_detection_snap_enabled ? "true" : "false"
    BLOB_STORAGE_MAX_CONNECTIONS         = tostring(var.blob_storage_max_connections) # #422: pooled Blob Storage sockets per origin
    INGESTION_AI_BATCH_POLL_SCHEDULE     = var.ingestion_ai_batch_poll_schedule
    INGESTION_AI_BATCH_MAX_POLL_JOBS     = tostring(var.ingestion_ai_batch_max_poll_jobs)
    AZURE_AD_B2C_TENANT                  = var.azure_ad_b2c_tenant
    AZURE_AD_B2C_CLIENT_ID               = var.azure_ad_b2c_client_id
    AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = var.enable_document_intelligence ? azurerm_cognitive_account.document_intelligence[0].endpoint : ""
    AZURE_DOCUMENT_INTELLIGENCE_KEY      = var.enable_document_intelligence ? "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.document_intelligence_key[0].versionless_id})" : ""
    AZURE_OPENAI_DEPLOYMENT_LABEL        = var.openai_label_deployment_name
    AUTH_DEV_BYPASS                      = var.auth_dev_bypass ? "true" : "false"
    SHAREABLE_WISHLIST_ENABLED           = var.shareable_wishlist_enabled ? "true" : "false" # #268; off until roadmap section 6 decision 2
    SHAREABLE_LOOKS_ENABLED              = var.shareable_looks_enabled ? "true" : "false"    # saved-look share links; off until the owner turns them on
    BOTTLE_CAPTURE_ENABLED               = var.bottle_capture_enabled ? "true" : "false"     # guided bottle recognition flow; off until the owner turns it on
    IMAGE_PROXY_SIGNING_KEY              = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.image_proxy_signing_key.versionless_id})"
    CORS_ALLOWED_ORIGINS                 = join(",", local.function_cors_allowed_origins)
    # Entrypoint/import failures hard-fail host startup instead of surfacing as
    # route-level 404s. Was set by deploy.yml, which Terraform kept removing.
    FUNCTIONS_NODE_BLOCK_ON_ENTRY_POINT_ERROR = "true"
    # Optional Redis read-through cache. Empty when create_redis = false; the app
    # caching layer (lib/cache.ts) no-ops gracefully when these are unset.
    REDIS_URL = var.create_redis ? "rediss://${azurerm_managed_redis.main[0].hostname}:10000" : ""
    REDIS_KEY = var.create_redis ? "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.redis_key[0].versionless_id})" : ""
    # Runtime tuning (variables.tf "Function App runtime settings"); each defaults
    # to the code default and is set from the matching GitHub environment variable.
    AZURE_OPENAI_DEPLOYMENT               = local.openai_deployment_name_value
    CAPTURE_FRAME_SWEEP_SCHEDULE          = var.capture_frame_sweep_schedule
    CAPTURE_FRAME_RETENTION_SECONDS       = tostring(var.capture_frame_retention_seconds)
    CORS_ALLOWED_METHODS                  = var.cors_allowed_methods
    CORS_ALLOWED_HEADERS                  = var.cors_allowed_headers
    CORS_SUPPORT_CREDENTIALS              = var.cors_support_credentials ? "true" : "false"
    GALLERY_MAX_IMAGES_PER_SHADE          = tostring(var.gallery_max_images_per_shade)
    HEX_DETECTION_BATCH_MAX_IN_FLIGHT     = tostring(var.hex_detection_batch_max_in_flight)
    HEX_DETECTION_CONCURRENCY             = tostring(var.hex_detection_concurrency)
    HEX_DETECTION_DELAY_MS                = tostring(var.hex_detection_delay_ms)
    HEX_SNAP_MAX_DISTANCE                 = tostring(var.hex_snap_max_distance)
    IMAGE_PROXY_ID_TTL_SECONDS            = tostring(var.image_proxy_id_ttl_seconds)
    IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS    = tostring(var.image_proxy_private_id_ttl_seconds)
    IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL    = var.image_proxy_legacy_id_accept_until
    INGESTION_AI_IMAGE_PROXY_ORIGIN       = var.ingestion_ai_image_proxy_origin
    INGESTION_JOB_LOG_MAX_ENTRIES         = tostring(var.ingestion_job_log_max_entries)
    INGESTION_LOG_FLUSH_INTERVAL_MS       = tostring(var.ingestion_log_flush_interval_ms)
    INGESTION_WORKER_TIME_BUDGET_MS       = tostring(var.ingestion_worker_time_budget_ms)
    ORPHAN_MEDIA_SWEEP_SCHEDULE           = var.orphan_media_sweep_schedule
    ORPHAN_MEDIA_SWEEP_GRACE_SECONDS      = tostring(var.orphan_media_sweep_grace_seconds)
    ORPHAN_MEDIA_SWEEP_BATCH_SIZE         = tostring(var.orphan_media_sweep_batch_size)
    ORPHAN_MEDIA_SWEEP_MAX_PER_RUN        = tostring(var.orphan_media_sweep_max_per_run)
    PG_POOL_MAX                           = tostring(var.pg_pool_max)
    PG_IDLE_TIMEOUT_MS                    = tostring(var.pg_idle_timeout_ms)
    PG_CONNECTION_TIMEOUT_MS              = tostring(var.pg_connection_timeout_ms)
    PG_QUERY_MAX_RETRIES                  = tostring(var.pg_query_max_retries)
    PG_QUERY_RETRY_BASE_MS                = tostring(var.pg_query_retry_base_ms)
    SHOPIFY_CONNECTOR_REQUEST_TIMEOUT_MS  = tostring(var.shopify_connector_request_timeout_ms)
    SHOPIFY_CONNECTOR_MAX_RETRIES         = tostring(var.shopify_connector_max_retries)
    SHOPIFY_CONNECTOR_RETRY_BASE_DELAY_MS = tostring(var.shopify_connector_retry_base_delay_ms)
    SOURCE_IMAGE_CONTAINER                = var.source_image_container
    SOURCE_IMAGE_MAX_EDGE_PX              = tostring(var.source_image_max_edge_px)
    SOURCE_IMAGE_MAX_DOWNLOAD_BYTES       = tostring(var.source_image_max_download_bytes)
    SUSPICIOUS_HEX_REPEAT_MIN_RECORDS     = tostring(var.suspicious_hex_repeat_min_records)
    SUSPICIOUS_HEX_REPEAT_MIN_SHARE       = tostring(var.suspicious_hex_repeat_min_share)
    SUSPICIOUS_HEX_GRAYSCALE_MAX_CHROMA   = tostring(var.suspicious_hex_grayscale_max_chroma)
  }

  lifecycle {
    ignore_changes = [
      app_settings["WEBSITE_RUN_FROM_PACKAGE"],
      app_settings["WEBSITE_MOUNT_ENABLED"],
      # Written by Azure/functions-action on every code deploy.
      app_settings["WEBSITE_ENABLE_SYNC_UPDATE_SITE"],
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
  domain_name       = local.static_web_app_custom_domain_name
  validation_type   = local.static_web_app_validation_method

  lifecycle {
    ignore_changes = [validation_type]
  }
}


# ── Azure AI Document Intelligence (OCR for capture pipeline) ──

resource "azurerm_cognitive_account" "document_intelligence" {
  count               = var.enable_document_intelligence ? 1 : 0
  name                = "${local.resource_prefix}-docint-${local.unique_suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  kind                = "FormRecognizer"
  sku_name            = "S0"
}

resource "azurerm_key_vault_secret" "document_intelligence_key" {
  count        = var.enable_document_intelligence ? 1 : 0
  name         = "document-intelligence-key"
  value        = azurerm_cognitive_account.document_intelligence[0].primary_access_key
  key_vault_id = azurerm_key_vault.main.id
  depends_on = [
    azurerm_key_vault_access_policy.deployer,
    azurerm_key_vault_access_policy.github_actions,
    azurerm_cognitive_account.document_intelligence,
  ]
}

# ── Azure Managed Redis (optional) ─────────────────────────────
# Disabled by default (create_redis = false). The API caching layer reads
# REDIS_URL/REDIS_KEY and degrades gracefully when they are empty, so the app
# runs identically with or without this. Set create_redis = true to provision
# the cache and wire the connection settings into the Function App.

resource "azurerm_managed_redis" "main" {
  count               = var.create_redis ? 1 : 0
  name                = "${local.resource_prefix}-redis-${local.unique_suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku_name            = "Balanced_B0"

  default_database {
    access_keys_authentication_enabled = true
  }
}

resource "azurerm_key_vault_secret" "redis_key" {
  count        = var.create_redis ? 1 : 0
  name         = "redis-key"
  value        = azurerm_managed_redis.main[0].default_database[0].primary_access_key
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [
    azurerm_key_vault_access_policy.deployer,
    azurerm_key_vault_access_policy.github_actions,
    azurerm_managed_redis.main,
  ]
}

# ── Azure Speech Services ──────────────────────────────────────
# The External ID tenant and app registration are hand-managed; see the
# "Entra External ID web sign-in service principal" section at the end.

resource "azurerm_cognitive_account" "speech" {
  name                = "${local.resource_prefix}-speech"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  kind                = "SpeechServices"
  sku_name            = "S0"
}

resource "azurerm_cognitive_account" "openai" {
  for_each              = toset(local.openai_managed_regions)
  name                  = local.openai_account_name_by_region[each.key]
  resource_group_name   = azurerm_resource_group.main.name
  location              = each.key
  kind                  = "AIServices"
  sku_name              = "S0"
  custom_subdomain_name = local.openai_custom_subdomain_by_region[each.key]

  identity {
    type = "SystemAssigned"
  }

  lifecycle {
    # Azure auto-migrates accounts from "OpenAI" to "AIServices" kind.
    # kind is immutable so ignore drift to prevent a destructive replacement.
    # project_management_enabled defaults changed in provider; ignore to prevent forced replacement.
    ignore_changes = [kind, project_management_enabled]

    # Never guess the OpenAI region: `location` is immutable on the account,
    # so a region that differs from the existing account replaces it, which
    # soft-deletes the account and all its deployments (2026-10-19 prod
    # incident). Require an explicit openai_regions / openai_location.
    precondition {
      condition     = local.openai_region_explicit
      error_message = "Azure OpenAI region is not set. Set openai_regions or openai_location to the region the ${var.environment} OpenAI account already lives in (prod: centralus, dev: eastus); it is never derived from `location`. In CI set the OPENAI_LOCATION or OPENAI_REGIONS GitHub environment variable."
    }
  }
}

resource "azurerm_cognitive_deployment" "openai_hex" {
  for_each             = local.openai_create_resources ? azurerm_cognitive_account.openai : {}
  name                 = var.openai_deployment_name
  cognitive_account_id = each.value.id

  model {
    format  = "OpenAI"
    name    = var.openai_model_name
    version = var.openai_model_version
  }

  sku {
    name     = "GlobalStandard"
    capacity = var.openai_deployment_capacity
  }
}

resource "azurerm_cognitive_deployment" "openai_hex_batch" {
  for_each             = local.openai_batch_deployment_managed ? azurerm_cognitive_account.openai : {}
  name                 = local.openai_batch_deployment_name_trimmed
  cognitive_account_id = each.value.id

  model {
    format  = "OpenAI"
    name    = local.openai_batch_model_name_value
    version = local.openai_batch_model_version_value
  }

  sku {
    name     = var.openai_batch_deployment_sku_name
    capacity = var.openai_batch_deployment_capacity
  }
}

# Send Azure OpenAI diagnostics to the shared Log Analytics workspace
# (same workspace backing Application Insights).
resource "azurerm_monitor_diagnostic_setting" "openai" {
  for_each                   = local.openai_create_resources ? azurerm_cognitive_account.openai : {}
  name                       = "openai-observability-${local.openai_region_slug_by_region[each.key]}"
  target_resource_id         = each.value.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category_group = "allLogs"
  }

  enabled_metric {
    category = "AllMetrics"
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

# ── Entra External ID web sign-in service principal ────────────
# Only the enterprise app (service principal) of the web sign-in app is
# managed; the app registration (redirect URIs, app roles such as `admin`,
# optional claims) stays hand-managed in the External ID tenant. Gated by
# manage_ciam_service_principal so each environment opts in after its current
# settings have been checked. Signing in must not need an app role
# assignment: admin is still granted with the `admin` app role, which keeps
# working with assignment not required.

data "azuread_service_principal" "ciam_web" {
  count     = var.manage_ciam_service_principal ? 1 : 0
  provider  = azuread.ciam
  client_id = var.azure_ad_b2c_client_id

  lifecycle {
    precondition {
      condition     = can(regex("^[0-9a-fA-F-]{36}$", var.ciam_tenant_id)) && can(regex("^[0-9a-fA-F-]{36}$", var.azure_ad_b2c_client_id))
      error_message = "manage_ciam_service_principal needs ciam_tenant_id and azure_ad_b2c_client_id set to GUIDs."
    }
  }
}

import {
  for_each = data.azuread_service_principal.ciam_web
  to       = azuread_service_principal.ciam_web[each.key]
  id       = each.value.object_id
}

resource "azuread_service_principal" "ciam_web" {
  count     = var.manage_ciam_service_principal ? 1 : 0
  provider  = azuread.ciam
  client_id = var.azure_ad_b2c_client_id

  # AADSTS50105 for every new sign-up when true.
  app_role_assignment_required = false

  lifecycle {
    # Deleting the service principal drops every app role assignment,
    # including admin. To stop managing it, remove it from state
    # (`terraform state rm` or a `removed` block with destroy = false)
    # before turning manage_ciam_service_principal off.
    prevent_destroy = true

    # Hand-managed in the portal for now.
    ignore_changes = [
      account_enabled,
      alternative_names,
      description,
      feature_tags,
      features,
      login_url,
      notes,
      notification_email_addresses,
      owners,
      preferred_single_sign_on_mode,
      saml_single_sign_on,
      tags,
    ]
  }
}
