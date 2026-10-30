import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const remote = "postgres://u:p@ep-x.us-east-1.aws.neon.tech/db";
const local = "postgres://postgres:postgres@localhost:5433/splitwisest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("ALLOW_REMOTE_DB", "");
  vi.stubEnv("NEON_LOCAL_PROXY", "");
  vi.stubEnv("DATABASE_URL", remote);
});

afterEach(() => vi.unstubAllEnvs());

describe("local database guard", () => {
  it.each(["test", "development", ""])("blocks Neon in %s before creating a client", async (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    await expect(import("../db")).rejects.toThrow(/pnpm db:local/);
  });

  it.each([
    "postgres://u:p@EP-X.US-EAST-1.AWS.NEON.TECH/db",
    "postgres://u:p@ep-x.us-east-1.aws.neon.tech./db",
  ])("blocks normalized Neon host %s", async (url) => {
    vi.stubEnv("DATABASE_URL", url);
    await expect(import("../neon-local")).rejects.toThrow(/ALLOW_REMOTE_DB=1/);
  });

  it("does not let the local proxy bypass the guard", async () => {
    vi.stubEnv("NEON_LOCAL_PROXY", "http://localhost:4444/sql");
    await expect(import("../db")).rejects.toThrow(/pnpm db:local/);
  });

  it("blocks development before Next.js starts", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(import("../../../next.config")).rejects.toThrow(/pnpm db:local/);
  });

  it.each(["true", "0"])("rejects opt-in value %s", async (value) => {
    vi.stubEnv("ALLOW_REMOTE_DB", value);
    await expect(import("../db")).rejects.toThrow(/ALLOW_REMOTE_DB=1/);
  });

  it("allows explicit remote migrations without making a request", async () => {
    vi.stubEnv("ALLOW_REMOTE_DB", "1");
    expect((await import("../db")).sql).toBeTypeOf("function");
  });

  it.each(["production", "vercel"])("allows %s without making a request", async (target) => {
    vi.stubEnv(target === "production" ? "NODE_ENV" : "VERCEL", target === "production" ? "production" : "1");
    expect((await import("../db")).sql).toBeTypeOf("function");
  });

  it("uses the local HTTP proxy", async () => {
    vi.stubEnv("DATABASE_URL", local);
    vi.stubEnv("NEON_LOCAL_PROXY", "http://localhost:4444/sql");
    expect((await import("../db")).sql).toBeTypeOf("function");
    const { neonConfig } = await import("@neondatabase/serverless");
    expect(typeof neonConfig.fetchEndpoint === "function" && neonConfig.fetchEndpoint("localhost", 5433, {}))
      .toBe("http://localhost:4444/sql");
  });

  it("keeps missing database configuration closed", async () => {
    vi.stubEnv("DATABASE_URL", "");
    await expect(import("../db")).rejects.toThrow(/DATABASE_URL is not set/);
  });
});
