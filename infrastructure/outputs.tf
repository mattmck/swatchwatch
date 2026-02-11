output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "function_app_name" {
  value = azurerm_linux_function_app.main.name
}

output "function_app_hostname" {
  value = azurerm_linux_function_app.main.default_hostname
}

output "static_web_app_name" {
  value = azurerm_static_web_app.main.name
}

output "static_web_app_hostname" {
  value = azurerm_static_web_app.main.default_host_name
}

output "postgres_server_name" {
  value = azurerm_postgresql_flexible_server.main.name
}

output "postgres_fqdn" {
  value = azurerm_postgresql_flexible_server.main.fqdn
}

output "postgres_database_name" {
  value = azurerm_postgresql_flexible_server_database.main.name
}

output "storage_account_name" {
  value = azurerm_storage_account.main.name
}

output "speech_service_name" {
  value = azurerm_cognitive_account.speech.name
}

output "speech_service_key" {
  value     = azurerm_cognitive_account.speech.primary_access_key
  sensitive = true
}

output "openai_account_name" {
  value = try(azurerm_cognitive_account.openai[0].name, "")
}

output "openai_endpoint" {
  value = local.openai_endpoint_value
}

output "openai_hex_deployment_name" {
  value = local.openai_deployment_name_value
}

output "openai_resources_provisioned" {
  value = var.create_openai_resources
}

output "application_insights_name" {
  value = azurerm_application_insights.main.name
}

output "log_analytics_workspace_name" {
  value = azurerm_log_analytics_workspace.main.name
}

# Key Vault and GitHub Actions OIDC configuration
output "key_vault_name" {
  description = "Name of the Key Vault"
  value       = azurerm_key_vault.main.name
}

output "github_client_id" {
  description = "Application (client) ID for GitHub Actions - add to GitHub Secrets as AZURE_CLIENT_ID"
  value       = azuread_application.github_actions.client_id
}

output "github_tenant_id" {
  description = "Azure AD tenant ID - add to GitHub Secrets as AZURE_TENANT_ID"
  value       = data.azurerm_client_config.current.tenant_id
}

output "subscription_id" {
  description = "Azure subscription ID - add to GitHub Secrets as AZURE_SUBSCRIPTION_ID"
  value       = data.azurerm_client_config.current.subscription_id
}
