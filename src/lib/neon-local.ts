import { neonConfig } from "@neondatabase/serverless";

if (process.env.VERCEL !== "1" && process.env.DATABASE_URL && process.env.ALLOW_REMOTE_DB !== "1") {
  const host = new URL(process.env.DATABASE_URL).hostname.toLowerCase().replace(/\.$/, "");
  if (host === "neon.tech" || host.endsWith(".neon.tech")) {
    throw new Error("Remote Neon database blocked. Run pnpm db:local and use its environment lines. Set ALLOW_REMOTE_DB=1 only for intentional remote access.");
  }
}

// Local-development escape hatch. When NEON_LOCAL_PROXY is set (to a local
// neon-proxy SQL-over-HTTP endpoint such as `http://localhost:4444/sql`), point
// the Neon serverless driver at that proxy in front of a plain Postgres, so the
// app can run and be verified end-to-end without a hosted Neon account.
//
// When NEON_LOCAL_PROXY is unset the driver uses the endpoint derived from
// DATABASE_URL. Remote Neon requires VERCEL=1 or ALLOW_REMOTE_DB=1, even for
// local production builds. A missing DATABASE_URL still throws at import in
// db.ts. See docs/DATABASE.md ("Local setup").
const localEndpoint = process.env.NEON_LOCAL_PROXY;
if (localEndpoint) {
  neonConfig.fetchEndpoint = () => localEndpoint;
  neonConfig.useSecureWebSocket = false;
  neonConfig.poolQueryViaFetch = true;
}
