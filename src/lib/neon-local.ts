import { neonConfig } from "@neondatabase/serverless";

const production = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
if (!production && process.env.DATABASE_URL && process.env.ALLOW_REMOTE_DB !== "1") {
  const host = new URL(process.env.DATABASE_URL).hostname.toLowerCase().replace(/\.$/, "");
  if (host === "neon.tech" || host.endsWith(".neon.tech")) {
    throw new Error("Remote Neon database blocked. Run pnpm db:local and use its environment lines. Set ALLOW_REMOTE_DB=1 only for intentional remote access.");
  }
}

const localEndpoint = process.env.NEON_LOCAL_PROXY;
if (localEndpoint) {
  neonConfig.fetchEndpoint = () => localEndpoint;
  neonConfig.useSecureWebSocket = false;
  neonConfig.poolQueryViaFetch = true;
}
