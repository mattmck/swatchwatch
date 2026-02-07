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

output "cosmos_account_name" {
  value = azurerm_cosmosdb_account.main.name
}

output "cosmos_endpoint" {
  value = azurerm_cosmosdb_account.main.endpoint
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
