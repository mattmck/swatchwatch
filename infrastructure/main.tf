terraform {
  required_version = ">= 1.5.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.100"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "azurerm" {
  features {}
}

resource "random_string" "suffix" {
  length  = 8
  special = false
  upper   = false
}

locals {
  resource_prefix = "${var.base_name}-${var.environment}"
  unique_suffix   = random_string.suffix.result
}

# ── Resource Group ──────────────────────────────────────────────

resource "azurerm_resource_group" "main" {
  name     = "${local.resource_prefix}-rg"
  location = var.location
}

# ── Cosmos DB (Serverless) ──────────────────────────────────────

resource "azurerm_cosmosdb_account" "main" {
  name                = "${local.resource_prefix}-cosmos-${local.unique_suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  offer_type          = "Standard"

  capabilities {
    name = "EnableServerless"
  }

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = azurerm_resource_group.main.location
    failover_priority = 0
  }
}

resource "azurerm_cosmosdb_sql_database" "main" {
  name                = "polish-inventory"
  resource_group_name = azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.main.name
}

resource "azurerm_cosmosdb_sql_container" "polishes" {
  name                = "polishes"
  resource_group_name = azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.main.name
  partition_key_paths = ["/userId"]
}

# ── Storage Account (polish images) ────────────────────────────

resource "azurerm_storage_account" "main" {
  name                     = "${var.base_name}${var.environment}${local.unique_suffix}"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  allow_nested_items_to_be_public = false
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

  site_config {
    application_stack {
      node_version = "20"
    }
  }

  app_settings = {
    FUNCTIONS_WORKER_RUNTIME    = "node"
    FUNCTIONS_EXTENSION_VERSION = "~4"
    COSMOS_DB_CONNECTION        = azurerm_cosmosdb_account.main.primary_sql_connection_string
  }
}

# ── Static Web App (Next.js frontend) ──────────────────────────

resource "azurerm_static_web_app" "main" {
  name                = "${local.resource_prefix}-web"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku_tier            = "Standard"
  sku_size            = "Standard"
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
