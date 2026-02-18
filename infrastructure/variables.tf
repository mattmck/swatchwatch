variable "location" {
  description = "The Azure region for all resources"
  type        = string
  default     = "centralus"
}

variable "openai_location" {
  description = "Optional override region for Azure OpenAI resources (defaults to `location` when null)"
  type        = string
  default     = null
  nullable    = true
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

variable "create_openai_resources" {
  description = "Create Azure OpenAI account/deployment resources. Set false when quota is unavailable and provide openai_endpoint/openai_api_key manually if needed."
  type        = bool
  default     = false
}

variable "retain_openai_account" {
  description = "Retain the legacy in-stack OpenAI account even when create_openai_resources=false (prevents destroy failures when nested Foundry project resources exist)."
  type        = bool
  default     = true
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
  default     = 10
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
