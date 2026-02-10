import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep static export for production deploys, but disable it in local dev to
  // avoid dynamic-route param restrictions during iterative development.
  output: process.env.NODE_ENV === "production" ? "export" : undefined,
  trailingSlash: true,
};

export default nextConfig;
