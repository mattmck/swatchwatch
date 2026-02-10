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
echo -e "${BLUE}▶ Step 3: Initializing Terraform...${NC}"
terraform init

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
echo "  - Terraform state: terraform.tfstate"
echo "  - Configuration: terraform.tfvars (gitignored)"
echo "  - Plan file: tfplan (gitignored)"
echo ""
echo "To destroy infrastructure later:"
echo "  terraform destroy"
