import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8001";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false, // Remove X-Powered-By: Next.js
  experimental: {
    proxyTimeout: 600_000, // 600s timeout for v20 SAM processing with up to 35 plates
    middlewareClientMaxBodySize: "50mb", // Large images at 4x upscale can be 10MB+
  },
  async headers() {
    return [
      {
        // Prevent Cloudflare and Next.js from caching pages
        // This stops the auth gate ghost issue where old pages get cached
        source: "/((?!_next/static|_next/image|favicon.ico).*)",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
          { key: "CDN-Cache-Control", value: "no-store" },
          { key: "Cloudflare-CDN-Cache-Control", value: "no-store" },
          { key: "Surrogate-Control", value: "no-store" },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self'",
              "connect-src 'self' blob:",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
  async rewrites() {
    return {
      afterFiles: [
        {
          source: "/api/:path*",
          destination: `${backendUrl}/api/:path*`,
        },
      ],
    };
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
});
