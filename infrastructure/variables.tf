variable "subscription_id" {
  description = "Azure subscription ID (required by azurerm provider v4+)"
  type        = string
}

variable "location" {
  description = "The Azure region for all resources"
  type        = string
  default     = "centralus"
}

variable "openai_location" {
  description = "Azure OpenAI region used when `openai_regions` is empty. Must be the region the environment's OpenAI account already lives in (prod: centralus, dev: eastus): a different value replaces the account, which soft-deletes it and every deployment. In CI it comes from the environment's OPENAI_LOCATION GitHub variable. When `create_openai_resources` is true, either this or `openai_regions` must be set; the region is never guessed from `location`."
  type        = string
  default     = null
  nullable    = true
}

variable "openai_regions" {
  description = "Azure OpenAI regions to provision when create_openai_resources=true (takes precedence over openai_location). First region is treated as primary for function settings and backwards-compatible outputs. Removing a region from this list destroys that region's account and deployments."
  type        = list(string)
  default     = []
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "base_name" {
  description = "Base name for resources"
  type        = string
  default     = "swatchwatch"
}

variable "pg_admin_username" {
  description = "PostgreSQL administrator username"
  type        = string
  default     = "pgadmin"
  sensitive   = true
}

variable "pg_admin_password" {
  description = "PostgreSQL administrator password"
  type        = string
  sensitive   = true
}

variable "github_repository" {
  description = "GitHub repository in format 'owner/repo' for OIDC federation"
  type        = string
  default     = "your-github-username/polish-inventory"
}

variable "openai_custom_subdomain_name" {
  description = "Optional custom subdomain for the Azure OpenAI account. If not set, a name will be generated."
  type        = string
  default     = null
  nullable    = true
}

variable "apim_enabled" {
  description = "Create an Azure API Management instance for Azure OpenAI gateway routing."
  type        = bool
  default     = false
}

variable "apim_sku_name" {
  description = "Azure API Management SKU name."
  type        = string
  default     = "Consumption_0"
}

variable "apim_publisher_name" {
  description = "Publisher display name for Azure API Management."
  type        = string
  default     = "SwatchWatch"
}

variable "apim_publisher_email" {
  description = "Publisher email address for Azure API Management."
  type        = string
  default     = "platform@swatchwatch.app"
}

variable "apim_openai_api_suffix" {
  description = "API path suffix in APIM used for Azure OpenAI proxy calls."
  type        = string
  default     = "openai-gateway"
}

variable "apim_openai_subscription_key" {
  description = "Optional APIM subscription key for Azure OpenAI gateway calls. Stored in Key Vault when provided."
  type        = string
  default     = ""
  sensitive   = true
}

variable "apim_openai_subscription_key_uri" {
  description = "Optional existing Key Vault secret URI for the APIM subscription key. When set, Terraform will not create the APIM key secret."
  type        = string
  default     = ""
}

variable "openai_gateway_enabled" {
  description = "Enable Function App gateway mode (`AZURE_OPENAI_USE_GATEWAY=true`). Keep false until APIM routes/policies are configured."
  type        = bool
  default     = false
}

variable "openai_deployment_name" {
  description = "Azure OpenAI deployment name used for hex detection"
  type        = string
  default     = "hex-detector"
}

variable "openai_batch_deployment_name" {
  description = "Optional Azure OpenAI deployment name used specifically for batch hex detection. When empty, openai_deployment_name is reused."
  type        = string
  default     = ""
}

variable "openai_batch_model_name" {
  description = "Optional Azure OpenAI model name for the batch deployment. When empty, openai_model_name is reused."
  type        = string
  default     = ""
}

variable "openai_batch_model_version" {
  description = "Optional Azure OpenAI model version for the batch deployment. When empty, openai_model_version is reused."
  type        = string
  default     = ""
}

variable "openai_batch_deployment_sku_name" {
  description = "SKU name for the batch hex detection deployment"
  type        = string
  default     = "GlobalBatch"
}

variable "openai_batch_deployment_capacity" {
  description = "Capacity for the batch hex detection deployment. For GlobalBatch this is the enqueued-token limit in thousands (5000 = 5M tokens); it is not billed — batch is billed per token processed."
  type        = number
  default     = 5000
}

variable "create_openai_resources" {
  description = "Create Azure OpenAI account/deployment resources. Set false when quota is unavailable and provide openai_endpoint/openai_api_key manually if needed."
  type        = bool
  default     = false
}


variable "openai_endpoint" {
  description = "Optional existing Azure OpenAI endpoint (used when create_openai_resources=false)."
  type        = string
  default     = ""
}

variable "openai_api_key" {
  description = "Optional existing Azure OpenAI API key (used when create_openai_resources=false). Stored in Key Vault."
  type        = string
  default     = ""
  sensitive   = true
}

variable "openai_key_vault_secret_uri" {
  description = "Optional existing Key Vault secret URI containing the Azure OpenAI API key. Use this to avoid passing openai_api_key to Terraform."
  type        = string
  default     = ""
}

variable "openai_model_name" {
  description = "Azure OpenAI model name for the hex detection deployment"
  type        = string
  default     = "gpt-4o-mini"
}

variable "openai_model_version" {
  description = "Azure OpenAI model version for the hex detection deployment"
  type        = string
  default     = "2024-07-18"
}

variable "openai_deployment_capacity" {
  description = "Azure OpenAI deployment capacity units for the hex detection deployment"
  type        = number
  default     = 100
}

variable "is_automation" {
  description = "Flag to indicate if Terraform is running in an automation pipeline"
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "Root domain name for the application (e.g., swatchwatch.app)"
  type        = string
  default     = "swatchwatch.app"
}

variable "azure_ad_b2c_tenant" {
  description = "Azure AD B2C/Entra External ID tenant name for Function App auth"
  type        = string
  default     = "to-be-added"
}

variable "azure_ad_b2c_client_id" {
  description = "Azure AD B2C/Entra External ID application client ID for Function App JWT audience"
  type        = string
  default     = "to-be-added"
}

variable "manage_ciam_service_principal" {
  description = "Manage the web sign-in app's service principal (enterprise app) in the Entra External ID tenant: imports it and sets app_role_assignment_required = false. Turn on per environment only after checking that tenant's current settings."
  type        = bool
  default     = false
}

variable "ciam_tenant_id" {
  description = "Entra External ID (CIAM) tenant ID that hosts the web sign-in app (azure_ad_b2c_client_id). Required when manage_ciam_service_principal = true."
  type        = string
  default     = ""
}

variable "ciam_terraform_client_id" {
  description = "Client ID of the deployer app registration in the CIAM tenant that Deploy Infra signs in to with GitHub OIDC (federated credential). Empty = use Azure CLI credentials (local runs)."
  type        = string
  default     = ""
}

variable "auth_dev_bypass" {
  description = "Enable dev auth bypass in Functions (`Bearer dev:<userId>` tokens)"
  type        = bool
  default     = false
}

variable "shareable_wishlist_enabled" {
  description = "Enable opt-in public wishlist share links (SHAREABLE_WISHLIST_ENABLED, issue #268). Off by default."
  type        = bool
  default     = false
}

variable "ingestion_job_queue_name" {
  description = "Azure Storage Queue name for ingestion jobs"
  type        = string
  default     = "ingestion-jobs"
}

variable "azure_openai_batch_api_version" {
  description = "Azure OpenAI API version for Files/Batch endpoints"
  type        = string
  default     = "2025-03-01-preview"
}

variable "azure_openai_batch_completion_window" {
  description = "Completion window sent to Azure OpenAI batch creation"
  type        = string
  default     = "24h"
}

variable "azure_openai_vision_detail" {
  description = "Image detail level for vision hex detection (low | high | auto)"
  type        = string
  default     = "low"

  validation {
    condition     = contains(["low", "high", "auto"], var.azure_openai_vision_detail)
    error_message = "azure_openai_vision_detail must be one of: low, high, auto."
  }
}

variable "hex_detection_batch_enabled" {
  description = "Enable Azure OpenAI Batch API for Shopify image-based hex detection"
  type        = bool
  default     = false
}

variable "hex_detection_snap_enabled" {
  description = "Snap vision-detected hexes to the nearest palette chip measured from the same image (HEX_DETECTION_SNAP_ENABLED)"
  type        = bool
  default     = false
}

variable "hex_detection_batch_min_images" {
  description = "Minimum candidate image count before switching ingestion to batch mode"
  type        = number
  default     = 5
}

variable "enable_document_intelligence" {
  description = "Provision Azure AI Document Intelligence for server-side OCR in the capture pipeline"
  type        = bool
  default     = false
}

variable "openai_label_deployment_name" {
  description = "Azure OpenAI deployment name used for label OCR structured extraction. Falls back to AZURE_OPENAI_DEPLOYMENT_HEX when empty."
  type        = string
  default     = ""
}

variable "ingestion_ai_batch_poll_schedule" {
  description = "NCRONTAB schedule for ingestion-ai-batch-poller"
  type        = string
  default     = "0 */2 * * * *"
}

variable "ingestion_ai_batch_max_poll_jobs" {
  description = "Maximum awaiting batch jobs processed per poller run"
  type        = number
  default     = 10
}

variable "appinsights_daily_cap_gb" {
  description = "Daily ingestion cap (GB) for Application Insights and its Log Analytics workspace. null = the environment's entry in appinsights_daily_cap_gb_defaults. Telemetry stops for the rest of the day once hit (the daily-cap alert reports it)."
  type        = number
  default     = null
}

variable "appinsights_daily_cap_gb_defaults" {
  description = "Default daily ingestion cap (GB) per environment, used when appinsights_daily_cap_gb is null. Environments not listed use the dev entry (D15: 0.5 GB dev, 2 GB prod)."
  type        = map(number)
  default = {
    dev  = 0.5
    prod = 2
  }
}

# ── Alerts + availability (observability Phase 3) ──────────────

variable "alerts_enabled" {
  description = "Create the action group, alert rules and availability tests. null = true for prod, false otherwise (D16: prod only)."
  type        = bool
  default     = null
}

variable "alert_email" {
  description = "Address the alert action group emails. Set through the ALERT_EMAIL GitHub environment secret/variable; never commit it in tfvars. Empty = alert rules still fire in the portal but nobody is emailed."
  type        = string
  default     = ""
}

variable "alert_api_5xx_threshold" {
  description = "API alert fires when more than this many 5xx requests (per result code) are recorded in 5 minutes."
  type        = number
  default     = 5
}

variable "alert_server_exception_threshold" {
  description = "Exception-spike alert fires when Functions (server) exceptions exceed this count in 15 minutes."
  type        = number
  default     = 10
}

variable "alert_browser_exception_threshold" {
  description = "Exception-spike alert fires when browser exceptions exceed this count in 15 minutes. Higher than the server threshold because browser extensions and flaky networks add noise."
  type        = number
  default     = 25
}

variable "availability_test_frequency_seconds" {
  description = "How often each availability test runs from each location (300, 600 or 900). Standard tests are billed per execution."
  type        = number
  default     = 300

  validation {
    condition     = contains([300, 600, 900], var.availability_test_frequency_seconds)
    error_message = "availability_test_frequency_seconds must be 300, 600 or 900."
  }
}

variable "availability_test_locations" {
  description = "Availability test geo locations (Azure location ids). Default: East US, South Central US, West US. The availability alert fires when 2 or more fail."
  type        = list(string)
  default     = ["us-va-ash-azr", "us-tx-sn1-azr", "us-ca-sjc-azr"]

  validation {
    condition     = length(var.availability_test_locations) >= 2
    error_message = "availability_test_locations needs at least 2 locations (the alert fires on 2 failed locations)."
  }
}

variable "create_redis" {
  description = "Provision Azure Managed Redis and wire REDIS_URL/REDIS_KEY into the Function App. Disabled by default; the API caching layer (lib/cache.ts) degrades gracefully when these settings are empty. Set to true to enable read-through caching."
  type        = bool
  default     = false
}

# ── Backups ─────────────────────────────────────────────────────

variable "pg_backup_retention_days" {
  description = "Postgres built-in point-in-time restore window in days (7-35). Backup storage up to the provisioned storage size is included in the server price."
  type        = number
  default     = 35

  validation {
    condition     = var.pg_backup_retention_days >= 7 && var.pg_backup_retention_days <= 35
    error_message = "pg_backup_retention_days must be between 7 and 35."
  }
}

variable "blob_soft_delete_retention_days" {
  description = "Days deleted blobs and deleted containers stay recoverable in the app storage account (1-365)."
  type        = number
  default     = 30

  validation {
    condition     = var.blob_soft_delete_retention_days >= 1 && var.blob_soft_delete_retention_days <= 365
    error_message = "blob_soft_delete_retention_days must be between 1 and 365."
  }
}

variable "blob_version_retention_days" {
  description = "Days previous versions of swatch and nail-photo blobs are kept before the management policy deletes them."
  type        = number
  default     = 30
}

variable "tfstate_version_retention_days" {
  description = "Days previous Terraform state versions are kept in the tfstate container."
  type        = number
  default     = 90
}

variable "backup_vault_enabled" {
  description = "Create the Azure Backup vault with weekly Postgres and daily nail-photo backups. null = true for prod, false otherwise. The first apply that enables it needs User Access Administrator (role assignments), so run it locally."
  type        = bool
  default     = null
}

variable "delete_locks_enabled" {
  description = "Put CanNotDelete locks on the Postgres server, storage account and backup vault. null = true for prod, false otherwise. Creating locks needs Owner or User Access Administrator."
  type        = bool
  default     = null
}

variable "pg_vault_backup_retention" {
  description = "ISO 8601 retention for weekly Postgres vault backups (e.g. P3M). Changing it replaces the backup policy; see the Backups section in main.tf."
  type        = string
  default     = "P3M"
}

variable "nail_photo_vault_backup_retention" {
  description = "ISO 8601 retention for daily nail-photo vault backups (e.g. P30D). Changing it replaces the backup policy; see the Backups section in main.tf."
  type        = string
  default     = "P30D"
}

variable "vault_backup_monthly_retention" {
  description = "ISO 8601 retention for the first vault backup of each month, Postgres and nail photos (e.g. P1Y). Changing it replaces the backup policies."
  type        = string
  default     = "P1Y"
}
