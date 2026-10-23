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

variable "shareable_looks_enabled" {
  description = "Enable opt-in public share links for saved looks (SHAREABLE_LOOKS_ENABLED). Off by default."
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

variable "blob_storage_max_connections" {
  description = "Sockets per storage origin in the Function App's pooled Blob Storage HTTP agent (BLOB_STORAGE_MAX_CONNECTIONS); bounds outbound SNAT use on the Consumption plan"
  type        = number
  default     = 16

  validation {
    condition     = var.blob_storage_max_connections >= 1 && var.blob_storage_max_connections <= 128 && floor(var.blob_storage_max_connections) == var.blob_storage_max_connections
    error_message = "blob_storage_max_connections must be a whole number between 1 and 128."
  }
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

# ── Function App runtime settings ─────────────────────────────
# Every Functions app setting the code reads is Terraform-managed (app_settings
# replaces the whole set on apply, so a setting edited only in the portal is
# removed). Defaults equal the code defaults; Deploy Infra sets each one from the
# GitHub environment variable of the same name as the app setting.

variable "capture_frame_sweep_schedule" {
  description = "NCRONTAB schedule of the capture-frame-sweep timer that deletes Rapid Add frame blobs past their retention (CAPTURE_FRAME_SWEEP_SCHEDULE)"
  type        = string
  default     = "0 0 * * * *"
}

variable "capture_frame_retention_seconds" {
  description = "Age (seconds since image_asset.captured_at) after which the capture-frame sweep deletes a frame's blob, 3600-604800 (CAPTURE_FRAME_RETENTION_SECONDS)"
  type        = number
  default     = 86400

  validation {
    condition     = var.capture_frame_retention_seconds >= 3600 && var.capture_frame_retention_seconds <= 604800 && floor(var.capture_frame_retention_seconds) == var.capture_frame_retention_seconds
    error_message = "capture_frame_retention_seconds must be a whole number between 3600 and 604800."
  }
}

variable "cors_allowed_methods" {
  description = "Access-Control-Allow-Methods sent by the API (lib/http.ts) (CORS_ALLOWED_METHODS). Only effective locally while the Function App's platform cors block is set: App Service CORS answers preflights and sets the CORS headers in Azure"
  type        = string
  default     = "GET,POST,PUT,PATCH,DELETE,OPTIONS"
}

variable "cors_allowed_headers" {
  description = "Access-Control-Allow-Headers sent by the API; keep the trace headers so browser telemetry can correlate (CORS_ALLOWED_HEADERS). Only effective locally while the Function App's platform cors block is set: App Service CORS answers preflights and sets the CORS headers in Azure"
  type        = string
  default     = "Content-Type, Authorization, traceparent, tracestate, Request-Id, Request-Context"
}

variable "cors_support_credentials" {
  description = "Add Access-Control-Allow-Credentials for matched origins (CORS_SUPPORT_CREDENTIALS). Only effective locally while the Function App's platform cors block is set: App Service CORS answers preflights and sets the CORS headers in Azure"
  type        = bool
  default     = false
}

variable "gallery_max_images_per_shade" {
  description = "Max source_gallery images one product links per ingest (0 = unlimited) (GALLERY_MAX_IMAGES_PER_SHADE)"
  type        = number
  default     = 0
}

variable "hex_detection_batch_max_in_flight" {
  description = "Pending Azure OpenAI batches per ingestion job before it pauses for awaiting_ai, 1-100 (HEX_DETECTION_BATCH_MAX_IN_FLIGHT)"
  type        = number
  default     = 20
}

variable "hex_detection_concurrency" {
  description = "Parallel sync vision hex detection calls, 1-32; capped by the deployment's TPM quota (HEX_DETECTION_CONCURRENCY)"
  type        = number
  default     = 4
}

variable "hex_detection_delay_ms" {
  description = "Pause after each sync vision call per slot, 0-60000 (0 disables) (HEX_DETECTION_DELAY_MS)"
  type        = number
  default     = 1000
}

variable "hex_snap_max_distance" {
  description = "Largest OKLAB distance at which the snap step replaces the model hex with the nearest measured palette chip (HEX_SNAP_MAX_DISTANCE)"
  type        = number
  default     = 0.1
}

variable "image_proxy_id_ttl_seconds" {
  description = "Minimum lifetime of public v2 image proxy ids, 3600-2592000 (IMAGE_PROXY_ID_TTL_SECONDS)"
  type        = number
  default     = 259200
}

variable "image_proxy_private_id_ttl_seconds" {
  description = "Minimum lifetime of owner-scoped v3 image proxy ids, 300-86400 (IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS)"
  type        = number
  default     = 3600
}

variable "image_proxy_legacy_id_accept_until" {
  description = "ISO-8601 cutoff for accepting legacy v1 image ids (empty = rejected) (IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL)"
  type        = string
  default     = ""
}

variable "ingestion_ai_image_proxy_origin" {
  description = "Public origin for image proxy URLs sent to Azure OpenAI (empty = https://$WEBSITE_HOSTNAME) (INGESTION_AI_IMAGE_PROXY_ORIGIN)"
  type        = string
  default     = ""
}

variable "ingestion_job_log_max_entries" {
  description = "Log entries kept per ingestion job, 100-2000 (INGESTION_JOB_LOG_MAX_ENTRIES)"
  type        = number
  default     = 500
}

variable "ingestion_log_flush_interval_ms" {
  description = "Ingestion job log flush interval, 1000-120000 (INGESTION_LOG_FLUSH_INTERVAL_MS)"
  type        = number
  default     = 10000
}

variable "ingestion_worker_time_budget_ms" {
  description = "Wall-clock budget per ingestion worker invocation before it checkpoints, 30000-270000 (INGESTION_WORKER_TIME_BUDGET_MS)"
  type        = number
  default     = 240000
}

variable "orphan_media_sweep_schedule" {
  description = "NCRONTAB schedule of the orphan-media-sweep timer (ORPHAN_MEDIA_SWEEP_SCHEDULE)"
  type        = string
  default     = "0 17 3 * * *"
}

variable "orphan_media_sweep_grace_seconds" {
  description = "Minimum captured_at age before an unreferenced user media asset is swept, 3600-2592000 (ORPHAN_MEDIA_SWEEP_GRACE_SECONDS)"
  type        = number
  default     = 86400
}

variable "orphan_media_sweep_batch_size" {
  description = "Orphan media sweep rows per scan query, 1-1000 (ORPHAN_MEDIA_SWEEP_BATCH_SIZE)"
  type        = number
  default     = 100
}

variable "orphan_media_sweep_max_per_run" {
  description = "Orphan media assets swept per run, 1-20000 (ORPHAN_MEDIA_SWEEP_MAX_PER_RUN)"
  type        = number
  default     = 2000
}

variable "pg_pool_max" {
  description = "Postgres pool size per Function instance, 1-100 (PG_POOL_MAX)"
  type        = number
  default     = 10
}

variable "pg_idle_timeout_ms" {
  description = "Postgres pool idle client timeout (PG_IDLE_TIMEOUT_MS)"
  type        = number
  default     = 30000
}

variable "pg_connection_timeout_ms" {
  description = "Postgres connection timeout (PG_CONNECTION_TIMEOUT_MS)"
  type        = number
  default     = 15000
}

variable "pg_query_max_retries" {
  description = "Retries for retry-safe queries on connection timeouts (PG_QUERY_MAX_RETRIES)"
  type        = number
  default     = 2
}

variable "pg_query_retry_base_ms" {
  description = "Base delay between Postgres query retries (PG_QUERY_RETRY_BASE_MS)"
  type        = number
  default     = 250
}

variable "shopify_connector_request_timeout_ms" {
  description = "Shopify connector request timeout, 5000-180000 (SHOPIFY_CONNECTOR_REQUEST_TIMEOUT_MS)"
  type        = number
  default     = 45000
}

variable "shopify_connector_max_retries" {
  description = "Shopify connector retries per request, 0-6 (SHOPIFY_CONNECTOR_MAX_RETRIES)"
  type        = number
  default     = 2
}

variable "shopify_connector_retry_base_delay_ms" {
  description = "Shopify connector linear backoff base, 100-30000 (SHOPIFY_CONNECTOR_RETRY_BASE_DELAY_MS)"
  type        = number
  default     = 1000
}

variable "source_image_container" {
  description = "Blob container for catalog images and their thumbnail variants (the only container public v2 ids read) (SOURCE_IMAGE_CONTAINER)"
  type        = string
  default     = "source-images"
}

variable "source_image_max_edge_px" {
  description = "Long edge above which catalog images are downscaled before storage, 256-8192 (SOURCE_IMAGE_MAX_EDGE_PX)"
  type        = number
  default     = 2048
}

variable "source_image_max_download_bytes" {
  description = "Largest catalog image download accepted before resizing, 5-100 MB (SOURCE_IMAGE_MAX_DOWNLOAD_BYTES)"
  type        = number
  default     = 26214400
}

variable "suspicious_hex_repeat_min_records" {
  description = "Records sharing one vendor hex in a source batch before it counts as a store template default (SUSPICIOUS_HEX_REPEAT_MIN_RECORDS)"
  type        = number
  default     = 3
}

variable "suspicious_hex_repeat_min_share" {
  description = "Share (0-1) of a source batch sharing one vendor hex before it counts as a store template default (SUSPICIOUS_HEX_REPEAT_MIN_SHARE)"
  type        = number
  default     = 0.1
}

variable "suspicious_hex_grayscale_max_chroma" {
  description = "OKLCH chroma below which a vendor hex is flagged as near-grayscale unless the name suggests gray (SUSPICIOUS_HEX_GRAYSCALE_MAX_CHROMA)"
  type        = number
  default     = 0.02
}
