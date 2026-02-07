# Azure Minimal IaC Bill of Materials (Dev / Stg / Prod) — Serverless-Heavy (v1.1)
_Date: 2026-02-07_

This is a minimal but production-safe layout for **one backend serving iOS/Android/Web**.

---

## Per-Environment (repeat for dev, stg, prod)

### Resource Groups (recommended)
- `rg-np-{env}-core`  (Functions, APIM, monitoring, Key Vault)
- `rg-np-{env}-data`  (Postgres/SQL, backups)
- `rg-np-{env}-media` (Storage accounts, CDN config if used)
- `rg-np-{env}-edge`  (Front Door, WAF, DNS)
- `rg-np-{env}-ops`   (Budgets, alerts, dashboards/runbooks)

### Required Services (MVP)
**Compute / API**
- Azure Functions (HTTP API)
- Durable Functions (can be same Function App)
- (Optional early) API Management (policy/rate limiting/versioning)

**Storage / Media**
- Storage Account:
  - Blob containers: `user-media-private`, `thumbs`, `normalized`, `public-swatch` (later)
  - Durable Functions storage (uses same storage account or dedicated one)

**Async / Events**
- Service Bus (recommended) OR Event Grid
  - capture finalize triggers
  - OCR/embedding jobs
  - retail offer refresh jobs (later)

**Data**
- Azure Database for PostgreSQL Flexible Server (recommended for pg_trgm + pgvector)
  - backups + PITR enabled for prod

**AI**
- Azure OpenAI (LLM parse + embeddings)
- Azure AI Vision or Document Intelligence (OCR)
- (Optional) Azure Speech (audio hint)

**Observability**
- Application Insights
- Log Analytics Workspace (recommended for central logs)
- Alerts (error rate, latency, queue depth, AI spend proxy)

**Security**
- Key Vault (secrets + certificates)
- Managed Identity for Function Apps
- Entra ID B2C (auth for users)
- Front Door + WAF (edge protection)

---

## Environment-Specific Sizing Guidance
### Dev
- Lowest SKUs, short retention, budgets/alerts aggressive
- OpenAI/Vision quotas low
- Consider pausing non-essential background jobs

### Staging
- Mirrors prod topology
- Moderate quotas; synthetic test traffic; smoke tests

### Prod
- WAF enabled, private endpoints preferred
- Resource locks on DB + KV + storage
- Backups/PITR + restore drills

---

## Networking Options (choose one)
### Option A (MVP-simple)
- Public DB/Storage endpoints
- Strict firewall rules + TLS + allowlists
- Faster to ship; harder to lock down later

### Option B (recommended for prod)
- VNet integration + Private Endpoints for DB and Storage
- Public access disabled for DB/Storage
- Front Door remains public → routes to API

---

## Required IaC Outputs (so clients can work)
- API base URL
- Auth config (B2C tenant/client ids, redirect URIs)
- Blob SAS policy settings (max size, expiry)
- Feature flag defaults per environment
- Monitoring keys / dashboard links

---

## Deployment/Promotion (recommended)
- IaC deploy → Functions deploy → DB migrations → smoke tests
- Stage/prod protected by approvals
- Rollback plan: previous Function artifact + DB migration rollback strategy
