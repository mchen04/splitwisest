import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sql, transaction, keys } = vi.hoisted(() => {
  const transaction = vi.fn(async (queries: unknown[]) => queries.map(() => []));
  const sql = Object.assign(vi.fn((strings: TemplateStringsArray) => Object.assign([], { query: strings.join("?") })), { transaction });
  return { sql, transaction, keys: vi.fn() };
});
vi.mock("@/lib/db", () => ({ sql }));
vi.mock("@/lib/web-push", () => ({
  pushKeys: keys, allowedPushUsers: () => null, sendPush: vi.fn(),
}));
const route = await import("@/app/api/notifications/deliver/route");
const secret = "s".repeat(40);
const request = (agent?: string, authorization = `Bearer ${secret}`) =>
  new NextRequest("https://app.example/api/notifications/deliver", {
    headers: { authorization, ...(agent ? { "user-agent": agent } : {}) },
  });
const statements = () => sql.mock.calls.map((args) => (args[0] as unknown as TemplateStringsArray).join("?"));

describe("scheduled delivery avoids unnecessary round trips", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T17:00:00Z"));
    vi.stubEnv("PUSH_CRON_SECRET", secret);
    sql.mockClear();
    transaction.mockClear();
    keys.mockReturnValue({ publicKey: "local", privateKey: "local", subject: "mailto:local@example.test" });
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps the daily Vercel schedule and runs GitHub retries every six hours", () => {
    const workflow = readFileSync(".github/workflows/notification-delivery.yml", "utf8");
    expect(workflow).toContain("cron: '23 */6 * * *'");
    expect(JSON.parse(readFileSync("vercel.json", "utf8")).crons).toEqual([
      { path: "/api/notifications/deliver", schedule: "0 17 * * *" },
    ]);
  });

  it("uses one statement for an idle retry and skips cleanup", async () => {
    const response = await route.POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 0, retried: 0, removed: 0, skipped: 0, failed: 0, remindersCreated: 0 });
    expect(sql).toHaveBeenCalledOnce();
    expect(transaction).not.toHaveBeenCalled();
    expect(statements().join(" ")).not.toContain("DELETE");
  });

  it("batches daily cleanup and the idle claim in one round trip", async () => {
    expect((await route.GET(request("vercel-cron/1.0"))).status).toBe(200);
    expect(transaction).toHaveBeenCalledOnce();
    expect(transaction.mock.calls[0][0]).toHaveLength(3);
    expect(statements().filter((query) => query.includes("DELETE"))).toHaveLength(2);
    expect(statements().join(" ")).toContain("interval '90 days'");
    expect(statements().join(" ")).toContain("sess.expires_at <= now()");
  });

  it("keeps daily cleanup when push delivery is disabled", async () => {
    keys.mockReturnValue(null);
    expect((await route.GET(request("vercel-cron/1.0"))).status).toBe(200);
    expect(transaction).toHaveBeenCalledOnce();
    expect(transaction.mock.calls[0][0]).toHaveLength(2);
    expect(statements().every((query) => query.includes("DELETE"))).toBe(true);
  });

  it("checks the scheduler secret before any query", async () => {
    expect((await route.GET(request("vercel-cron/1.0", "Bearer wrong"))).status).toBe(401);
    expect(sql).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
