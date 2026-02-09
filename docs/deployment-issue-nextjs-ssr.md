# Deployment Issue: Next.js SSR on Azure Static Web Apps

## Problem
Azure Static Web Apps only supports static Next.js exports. When using server rendering (SSR) with Next.js, the build output is placed in `.next` and does not contain a static `index.html`. Azure Static Web Apps expects a static artifact folder with an `index.html` file, so SSR builds fail to deploy.

## Error Message
```
Failed to find a default file in the app artifacts folder (apps/web/.next). Valid default files: index.html,Index.html.
If your application contains purely static content, please verify that the variable 'app_location' in your workflow file points to the root of your application.
If your application requires build steps, please validate that a default file exists in the build output directory.
```

## Solution
- For SSR: Deploy to Azure App Service or Azure Functions (with Next.js SSR support), not Static Web Apps.
- For Static Export: Use `output: 'export'` in next.config.js and implement `generateStaticParams()` for all dynamic routes.

## Action Required
Decide whether to:
- Switch to static export and add `generateStaticParams()` for all dynamic routes, or
- Move deployment to Azure App Service for full SSR support.

---

**References:**
- https://learn.microsoft.com/en-us/azure/static-web-apps/deploy-nextjs
- https://learn.microsoft.com/en-us/azure/app-service/quickstart-nextjs

---

*This issue blocks SSR deployment on Azure Static Web Apps. Please review and update deployment strategy accordingly.*
