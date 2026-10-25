#!/usr/bin/env bash
# Fails when the live Function App is missing a Terraform-managed app setting,
# or holds a different value for one. Compares azurerm_linux_function_app.main
# in the Terraform state (`terraform show -json`) with
# `az functionapp config appsettings list`. Prints setting names only, never
# values (several are secrets).
#
# Catches a deploy that writes back a stale copy of the settings, e.g.
# Azure/functions-action PUTs the full set it read when it started, so a
# Terraform apply in between is silently reverted (2026-10-23, dev).
#
# Usage: check-function-app-settings.sh [terraform dir, default infrastructure]
# Needs an initialized Terraform backend and an Azure CLI login.
set -euo pipefail

TF_DIR="${1:-infrastructure}"

# Keys in the resource's lifecycle.ignore_changes: written by the code deploy,
# not owned by Terraform.
IGNORED='["WEBSITE_RUN_FROM_PACKAGE","WEBSITE_MOUNT_ENABLED","WEBSITE_ENABLE_SYNC_UPDATE_SITE"]'

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

terraform -chdir="$TF_DIR" show -json > "$work/state.json"

jq '[.values.root_module.resources[]? | select(.address == "azurerm_linux_function_app.main")][0].values
    | {name, resource_group_name, app_settings: (.app_settings // {})}' \
  "$work/state.json" > "$work/want.json"
rm -f "$work/state.json"

APP_NAME="$(jq -r '.name // empty' "$work/want.json")"
RESOURCE_GROUP="$(jq -r '.resource_group_name // empty' "$work/want.json")"
if [ -z "$APP_NAME" ] || [ -z "$RESOURCE_GROUP" ]; then
  echo "::error::azurerm_linux_function_app.main is not in the Terraform state; cannot check its app settings."
  exit 1
fi

az functionapp config appsettings list \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  -o json > "$work/live.json"

# A null live value means the API did not return it: check presence only.
problems="$(jq -r -n \
  --slurpfile want "$work/want.json" \
  --slurpfile live "$work/live.json" \
  --argjson ignored "$IGNORED" '
  ($live[0] | map({key: .name, value: .value}) | from_entries) as $have
  | $want[0].app_settings
  | to_entries[]
  | .key as $k
  | select($ignored | index($k) | not)
  | if ($have | has($k) | not) then "missing: \($k)"
    elif $have[$k] != null and $have[$k] != .value then "differs: \($k)"
    else empty end')"

count="$(jq '.app_settings | length' "$work/want.json")"
if [ -z "$problems" ]; then
  echo "All $count Terraform-managed app settings are present on $APP_NAME with the applied values."
  exit 0
fi

echo "Live app settings on $APP_NAME do not match the Terraform state:"
echo "$problems"
echo "::error::$APP_NAME is missing Terraform-managed app settings or holds other values (listed above). Something wrote a stale settings set after Terraform's apply, usually a code deploy that overlapped it. Re-run Deploy Infra for this environment (it rewrites them), and check that no deploy ran at the same time. See infrastructure/README.md \"Deploy ordering\"."
exit 1
