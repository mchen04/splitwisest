import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deliverNotifications = vi.fn();
vi.mock("@/lib/notification-delivery", () => ({ deliverNotifications }));
vi.mock("@/lib/db", () => ({ sql: vi.fn().mockResolvedValue([]) }));

const secret = "s".repeat(40);
const totals = { accepted: 1, retried: 0, removed: 0, skipped: 0, failed: 0 };
const request = (method: string, auth?: string, agent?: string) =>
  new NextRequest("https://app.example/api/notifications/deliver", {
    method, headers: { ...(auth ? { authorization: auth } : {}), ...(agent ? { "user-agent": agent } : {}) },
  });

describe("notification retry endpoint", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("PUSH_CRON_SECRET", secret); deliverNotifications.mockResolvedValue(totals); });

  it("runs for the Vercel Cron GET with the shared secret", async () => {
    const route = await import("@/app/api/notifications/deliver/route");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await route.GET(request("GET", `Bearer ${secret}`, "vercel-cron/1.0"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(totals);
    expect(JSON.parse(info.mock.calls[0][0])).toEqual({ event: "notification-delivery", trigger: "vercel-cron", ...totals });
  });

  it("keeps POST for the GitHub workflow and manual runs", async () => {
    const route = await import("@/app/api/notifications/deliver/route");
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect((await route.POST(request("POST", `Bearer ${secret}`))).status).toBe(200);
  });

  it.each([undefined, "Bearer wrong", `Bearer ${secret}x`])("refuses authorization %s", async (auth) => {
    const route = await import("@/app/api/notifications/deliver/route");
    expect((await route.GET(request("GET", auth))).status).toBe(401);
    expect((await route.POST(request("POST", auth))).status).toBe(401);
    expect(deliverNotifications).not.toHaveBeenCalled();
  });

  it("is scheduled by Vercel Cron at the Hobby plan's daily limit", () => {
    const { crons } = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(crons).toEqual([{ path: "/api/notifications/deliver", schedule: expect.stringMatching(/^\d{1,2} \d{1,2} \* \* \*$/) }]);
  });
});
