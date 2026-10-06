import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // postgres.js and the Anthropic SDK run on the Node.js runtime only.
  serverExternalPackages: ["postgres"],
  poweredByHeader: false,
};

export default nextConfig;
