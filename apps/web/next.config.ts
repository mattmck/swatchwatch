import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Azure Static Web Apps requires a static artifact output folder containing index.html.
  // This enables Next.js static export to `apps/web/out`.
  output: "export",
  trailingSlash: true,
};

export default nextConfig;
