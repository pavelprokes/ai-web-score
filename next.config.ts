import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // postgres.js and the Anthropic SDK run on the Node.js runtime only.
  serverExternalPackages: ["postgres"],
  poweredByHeader: false,
  devIndicators: false,
  // The admin is never embedded and uses no device APIs. No script CSP: it needs nonces; HSTS comes from Vercel.
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    },
  ],
};

export default nextConfig;
