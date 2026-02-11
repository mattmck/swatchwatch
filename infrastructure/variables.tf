variable "location" {
  description = "The Azure region for all resources"
  type        = string
  default     = "centralus"
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

variable "openai_deployment_name" {
  description = "Azure OpenAI deployment name used for hex detection"
  type        = string
  default     = "hex-detector"
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
