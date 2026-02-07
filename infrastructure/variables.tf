variable "location" {
  description = "The Azure region for all resources"
  type        = string
  default     = "eastus"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "base_name" {
  description = "Base name for resources"
  type        = string
  default     = "polishinv"
}
