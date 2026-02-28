#!/bin/bash
set -euo pipefail

# SwatchWatch - Azure Infrastructure Bootstrap Script
# ========================================================
# This script guides you through provisioning Azure infrastructure
# with Key Vault, Managed Identity, and GitHub Actions OIDC federation.
#
# Prerequisites:
# - Azure CLI installed and logged in
# - Terraform installed
# - GitHub repository created
# - Appropriate Azure permissions (Contributor + User Access Administrator)

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BOLD}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   SwatchWatch - Infrastructure Bootstrap 💅              ║${NC}"
echo -e "${BOLD}╔═══════════════════════════════════════════════════════════╗${NC}"
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1. Check Prerequisites
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "${BLUE}▶ Step 1: Checking prerequisites...${NC}"

if ! command -v az &> /dev/null; then
    echo -e "${YELLOW}✗ Azure CLI not found. Install: https://aka.ms/azure-cli${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Azure CLI installed${NC}"

if ! command -v terraform &> /dev/null; then
    echo -e "${YELLOW}✗ Terraform not found. Install: https://www.terraform.io/downloads${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Terraform installed${NC}"

# Check if logged into Azure
if ! az account show &> /dev/null; then
    echo -e "${YELLOW}You're not logged into Azure. Running 'az login'...${NC}"
    az login
fi

ACCOUNT_NAME=$(az account show --query "user.name" -o tsv)
SUBSCRIPTION_NAME=$(az account show --query "name" -o tsv)
SUBSCRIPTION_ID=$(az account show --query "id" -o tsv)
TENANT_ID=$(az account show --query "tenantId" -o tsv)

echo -e "${GREEN}✓ Logged in as: ${ACCOUNT_NAME}${NC}"
echo -e "${GREEN}✓ Subscription: ${SUBSCRIPTION_NAME} (${SUBSCRIPTION_ID})${NC}"
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 2. Configure Terraform Variables
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "${BLUE}▶ Step 2: Configuration${NC}"

read -p "Environment (dev/staging/prod) [dev]: " ENVIRONMENT
ENVIRONMENT=${ENVIRONMENT:-dev}

read -p "Azure region [centralus]: " LOCATION
LOCATION=${LOCATION:-centralus}

read -p "GitHub repository (owner/repo) [mattmck/swatchwatch]: " GITHUB_REPO
GITHUB_REPO=${GITHUB_REPO:-mattmck/swatchwatch}

DEFAULT_TFSTATE_RESOURCE_GROUP=${TFSTATE_RESOURCE_GROUP:-swatchwatch-tfstate-rg}
DEFAULT_TFSTATE_STORAGE_ACCOUNT=${TFSTATE_STORAGE_ACCOUNT:-}
DEFAULT_TFSTATE_CONTAINER=${TFSTATE_CONTAINER:-tfstate}
DEFAULT_TFSTATE_BLOB_NAME=${TFSTATE_BLOB_NAME:-${ENVIRONMENT}.terraform.tfstate}

echo ""
echo -e "${BLUE}▶ Step 2b: Terraform remote state backend${NC}"
echo "Use an existing storage account for Terraform state."
read -p "Terraform state resource group [${DEFAULT_TFSTATE_RESOURCE_GROUP}]: " TFSTATE_RESOURCE_GROUP_INPUT
TFSTATE_RESOURCE_GROUP=${TFSTATE_RESOURCE_GROUP_INPUT:-$DEFAULT_TFSTATE_RESOURCE_GROUP}

if [ -n "$DEFAULT_TFSTATE_STORAGE_ACCOUNT" ]; then
    read -p "Terraform state storage account [${DEFAULT_TFSTATE_STORAGE_ACCOUNT}]: " TFSTATE_STORAGE_ACCOUNT_INPUT
    TFSTATE_STORAGE_ACCOUNT=${TFSTATE_STORAGE_ACCOUNT_INPUT:-$DEFAULT_TFSTATE_STORAGE_ACCOUNT}
else
    read -p "Terraform state storage account (required): " TFSTATE_STORAGE_ACCOUNT
fi

read -p "Terraform state container [${DEFAULT_TFSTATE_CONTAINER}]: " TFSTATE_CONTAINER_INPUT
TFSTATE_CONTAINER=${TFSTATE_CONTAINER_INPUT:-$DEFAULT_TFSTATE_CONTAINER}

read -p "Terraform state blob key [${DEFAULT_TFSTATE_BLOB_NAME}]: " TFSTATE_BLOB_NAME_INPUT
TFSTATE_BLOB_NAME=${TFSTATE_BLOB_NAME_INPUT:-$DEFAULT_TFSTATE_BLOB_NAME}

if [ -z "$TFSTATE_RESOURCE_GROUP" ] || [ -z "$TFSTATE_STORAGE_ACCOUNT" ]; then
    echo -e "${YELLOW}✗ Terraform backend resource group and storage account are required.${NC}"
    exit 1
fi

TARGET_RESOURCE_GROUP="swatchwatch-${ENVIRONMENT}-rg"
if [ "$TFSTATE_RESOURCE_GROUP" = "$TARGET_RESOURCE_GROUP" ]; then
    echo -e "${YELLOW}⚠ Terraform backend resource group matches deployment resource group (${TARGET_RESOURCE_GROUP}).${NC}"
    echo -e "${YELLOW}  This can require manual import and can complicate destroy workflows. Prefer a separate backend RG.${NC}"
fi

echo ""
echo -e "${YELLOW}⚠ PostgreSQL Password:${NC}"
echo "This will be stored securely in Azure Key Vault."
echo "Requirements: 8+ chars, uppercase, lowercase, numbers, symbols"
read -sp "Enter PostgreSQL admin password: " PG_PASSWORD
echo ""
read -sp "Confirm password: " PG_PASSWORD_CONFIRM
echo ""

if [ "$PG_PASSWORD" != "$PG_PASSWORD_CONFIRM" ]; then
    echo -e "${YELLOW}✗ Passwords don't match. Exiting.${NC}"
    exit 1
fi

# Create tfvars file
cat > terraform.tfvars <<EOF
environment      = "$ENVIRONMENT"
location         = "$LOCATION"
github_repository = "$GITHUB_REPO"
pg_admin_username = "pgadmin"
pg_admin_password = "$PG_PASSWORD"
EOF

echo -e "${GREEN}✓ Configuration saved to terraform.tfvars${NC}"
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 3. Terraform Init & Plan
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "${BLUE}▶ Step 3: Initializing Terraform backend...${NC}"

if ! az group show --name "$TFSTATE_RESOURCE_GROUP" --query name -o tsv >/dev/null 2>&1; then
    echo -e "${YELLOW}✗ Terraform state resource group not found: ${TFSTATE_RESOURCE_GROUP}${NC}"
    exit 1
fi

if ! az storage account show --resource-group "$TFSTATE_RESOURCE_GROUP" --name "$TFSTATE_STORAGE_ACCOUNT" --query name -o tsv >/dev/null 2>&1; then
    echo -e "${YELLOW}✗ Terraform state storage account not found: ${TFSTATE_STORAGE_ACCOUNT} (rg: ${TFSTATE_RESOURCE_GROUP})${NC}"
    exit 1
fi

TFSTATE_ACCESS_KEY=$(az storage account keys list \
  --resource-group "$TFSTATE_RESOURCE_GROUP" \
  --account-name "$TFSTATE_STORAGE_ACCOUNT" \
  --query '[0].value' -o tsv)

if [ -z "$TFSTATE_ACCESS_KEY" ]; then
    echo -e "${YELLOW}✗ Unable to resolve Terraform state storage account access key.${NC}"
    exit 1
fi

az storage container create \
  --name "$TFSTATE_CONTAINER" \
  --account-name "$TFSTATE_STORAGE_ACCOUNT" \
  --account-key "$TFSTATE_ACCESS_KEY" \
  --output none

terraform init -reconfigure \
  -backend-config="resource_group_name=$TFSTATE_RESOURCE_GROUP" \
  -backend-config="storage_account_name=$TFSTATE_STORAGE_ACCOUNT" \
  -backend-config="container_name=$TFSTATE_CONTAINER" \
  -backend-config="key=$TFSTATE_BLOB_NAME" \
  -backend-config="access_key=$TFSTATE_ACCESS_KEY"

echo ""
echo -e "${BLUE}▶ Step 4: Planning infrastructure...${NC}"
echo "This shows what will be created (no changes made yet)"
terraform plan -out=tfplan

echo ""
read -p "Review the plan above. Deploy infrastructure? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
    echo -e "${YELLOW}Deployment cancelled.${NC}"
    exit 0
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 4. Deploy Infrastructure
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo -e "${BLUE}▶ Step 5: Deploying infrastructure...${NC}"
echo "This takes ~5-10 minutes (Postgres provisioning is slow)"
terraform apply tfplan

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 5. Capture Outputs
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo -e "${GREEN}✓ Infrastructure deployed successfully!${NC}"
echo ""

GITHUB_CLIENT_ID=$(terraform output -raw github_client_id)
GITHUB_TENANT_ID=$(terraform output -raw github_tenant_id)
SUBSCRIPTION_ID=$(terraform output -raw subscription_id)
KEY_VAULT_NAME=$(terraform output -raw key_vault_name)
FUNCTION_APP_NAME=$(terraform output -raw function_app_name)
POSTGRES_FQDN=$(terraform output -raw postgres_fqdn)

echo -e "${BOLD}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   🎉 Deployment Complete - Next Steps                    ║${NC}"
echo -e "${BOLD}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 6. GitHub Secrets Instructions
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "${YELLOW}📋 GitHub Secrets (for CI/CD)${NC}"
echo "Go to: https://github.com/${GITHUB_REPO}/settings/secrets/actions"
echo ""
echo -e "${BOLD}Add these 3 secrets:${NC}"
echo ""
echo "AZURE_CLIENT_ID"
echo "  ${GITHUB_CLIENT_ID}"
echo ""
echo "AZURE_TENANT_ID"
echo "  ${GITHUB_TENANT_ID}"
echo ""
echo "AZURE_SUBSCRIPTION_ID"
echo "  ${SUBSCRIPTION_ID}"
echo ""
echo -e "${GREEN}✓ These enable passwordless GitHub Actions deployment${NC}"
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 7. Database Migration Instructions
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "${YELLOW}🗄️  Database Migration${NC}"
echo "Run these commands from /packages/functions:"
echo ""
echo "  cd ../packages/functions"
echo "  export PGHOST=${POSTGRES_FQDN}"
echo "  export PGPORT=5432"
echo "  export PGDATABASE=polish_inventory"
echo "  export PGUSER=pgadmin@polishinv-${ENVIRONMENT}-pg-*"
echo "  export PGPASSWORD='(use the password you entered)'"
echo "  npm run migrate"
echo ""
echo "Then seed external sources:"
echo "  psql -h \$PGHOST -U \$PGUSER -d \$PGDATABASE -f ../../docs/seed_data_sources.sql"
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 8. Additional Secrets (Future)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "${YELLOW}🔐 Additional Secrets (add later)${NC}"
echo "Store these in Key Vault when ready:"
echo ""
echo "  az keyvault secret set --vault-name ${KEY_VAULT_NAME} \\"
echo "    --name azure-openai-key --value 'your-openai-key'"
echo ""
echo "  az keyvault secret set --vault-name ${KEY_VAULT_NAME} \\"
echo "    --name azure-speech-key --value 'your-speech-key'"
echo ""
echo "Then update Function App settings to reference them."
echo ""

echo -e "${GREEN}✓ Bootstrap complete! Infrastructure is ready.${NC}"
echo ""
echo "Saved outputs:"
echo "  - Terraform state backend: azurerm"
echo "  - Terraform state resource group: ${TFSTATE_RESOURCE_GROUP}"
echo "  - Terraform state storage account: ${TFSTATE_STORAGE_ACCOUNT}"
echo "  - Terraform state container: ${TFSTATE_CONTAINER}"
echo "  - Terraform state key: ${TFSTATE_BLOB_NAME}"
echo "  - Configuration: terraform.tfvars (gitignored)"
echo "  - Plan file: tfplan (gitignored)"
echo ""
echo "To destroy infrastructure later:"
echo "  terraform destroy"
