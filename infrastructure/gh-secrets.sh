#!/bin/bash
set -euo pipefail

# Fetch OIDC secrets from Terraform state and set them in GitHub Actions.
# Run from the infrastructure/ directory after a successful `terraform apply`.
#
# Usage:
#   ./gh-secrets.sh              # print values only
#   ./gh-secrets.sh --apply      # set secrets via `gh secret set`

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Resolve the GitHub repo from terraform.tfvars or fall back to `gh` CLI
if [ -f terraform.tfvars ]; then
  GITHUB_REPO=$(grep 'github_repository' terraform.tfvars | sed 's/.*= *"\(.*\)"/\1/')
fi
GITHUB_REPO=${GITHUB_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)}

if [ -z "$GITHUB_REPO" ]; then
  echo -e "${YELLOW}Could not detect GitHub repo. Pass it via terraform.tfvars or run from a git repo with 'gh' configured.${NC}"
  exit 1
fi

# Read Terraform outputs
AZURE_CLIENT_ID=$(terraform output -raw github_client_id 2>/dev/null)
AZURE_TENANT_ID=$(terraform output -raw github_tenant_id 2>/dev/null)
AZURE_SUBSCRIPTION_ID=$(terraform output -raw subscription_id 2>/dev/null)

if [ -z "$AZURE_CLIENT_ID" ] || [ -z "$AZURE_TENANT_ID" ] || [ -z "$AZURE_SUBSCRIPTION_ID" ]; then
  echo -e "${YELLOW}Missing Terraform outputs. Have you run 'terraform apply' yet?${NC}"
  exit 1
fi

echo -e "${BOLD}GitHub Actions OIDC Secrets for ${GITHUB_REPO}${NC}"
echo ""
echo "  AZURE_CLIENT_ID       = ${AZURE_CLIENT_ID}"
echo "  AZURE_TENANT_ID       = ${AZURE_TENANT_ID}"
echo "  AZURE_SUBSCRIPTION_ID = ${AZURE_SUBSCRIPTION_ID}"
echo ""

if [ "${1:-}" = "--apply" ]; then
  echo -e "${GREEN}Setting secrets on ${GITHUB_REPO}...${NC}"
  gh secret set AZURE_CLIENT_ID       --repo "$GITHUB_REPO" --body "$AZURE_CLIENT_ID"
  gh secret set AZURE_TENANT_ID       --repo "$GITHUB_REPO" --body "$AZURE_TENANT_ID"
  gh secret set AZURE_SUBSCRIPTION_ID --repo "$GITHUB_REPO" --body "$AZURE_SUBSCRIPTION_ID"
  echo -e "${GREEN}Done. Secrets are set.${NC}"
else
  echo "Run with --apply to set these as GitHub secrets:"
  echo "  ./gh-secrets.sh --apply"
fi
