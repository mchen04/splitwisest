import type { NextConfig } from "next";
import "./src/lib/neon-local";
import { deploymentId } from "./src/lib/deployment-id";

// One id per deploy, shared by the client bundle (NEXT_PUBLIC_BUILD_ID), the
// generated service worker (scripts/generate-sw.ts), /api/version, and the
// x-build-id response header. deploymentId() throws on an empty id.
const id = deploymentId();

const nextConfig: NextConfig = {
  // Hide the floating dev-tools indicator so it never overlaps the app chrome
  // (it was being mistaken for the user avatar in design review captures).
  devIndicators: false,
  experimental: {
    turbopackSourceMaps: process.env.NODE_ENV !== "production",
  },
  generateBuildId: async () => id,
  env: {
    NEXT_PUBLIC_BUILD_ID: id,
  },
  async headers() {
    return [
      {
        // The worker script must always revalidate: the browser's update
        // algorithm compares bytes, and a cached /sw.js would pin old code.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        // Lets the worker tag cached documents with the build that produced
        // them, and lets verification identify a build without parsing HTML.
        source: "/:path*",
        headers: [{ key: "x-build-id", value: id }],
      },
    ];
  },
};

export default nextConfig;
