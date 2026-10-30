import { afterEach, describe, expect, it, vi } from "vitest";
import { privateHandler, privateJson } from "@/app/api/_lib/private-json";
import { AuthError } from "@/lib/auth";

const after = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ sql: vi.fn() }));
vi.mock("next/server", async (original) => ({
  ...await original<typeof import("next/server")>(), after,
}));

const respond = privateHandler(async (req: Request, value: unknown) => privateJson(req, value));

afterEach(() => vi.unstubAllEnvs());

const request = (cookie = "sw_session=a", tag?: string) => new Request("http://localhost/api/sync", {
  headers: { cookie, ...(tag ? { "if-none-match": tag } : {}) },
});

describe("private response revalidation", () => {
  it("returns the unchanged JSON with a private revalidation policy", async () => {
    const response = await respond(request(), { count: 4 });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"count":4}');
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("etag")).toMatch(/^W\/"[\w-]+"$/);
  });

  it.each(["weak", "strong", "list", "wildcard"])("returns no body for a matching %s validator", async (kind) => {
    const tag = privateJson(request(), { count: 4 }).headers.get("etag")!;
    const validator = kind === "strong" ? tag.slice(2) : kind === "list" ? `"old", ${tag}` : kind === "wildcard" ? "*" : tag;
    const response = await respond(request("sw_session=a", validator), { count: 4 });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(tag);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("replaces the body and validator when data changes", async () => {
    const tag = privateJson(request(), { count: 4 }).headers.get("etag")!;
    const response = await respond(request("sw_session=a", tag), { count: 5 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 5 });
    expect(response.headers.get("etag")).not.toBe(tag);
  });

  it("does not reuse a validator across session cookies", async () => {
    const tag = privateJson(request(), { count: 4 }).headers.get("etag")!;
    const response = await respond(request("sw_session=b", tag), { count: 4 });
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).not.toBe(tag);
  });

  it("runs successful-read notification hooks before returning 304", async () => {
    after.mockClear();
    vi.stubEnv("VAPID_PUBLIC_KEY", "test-public-key");
    const initial = new Request("http://localhost/api/groups/1/version");
    const tag = privateJson(initial, { version: "v1" }).headers.get("etag")!;
    const response = await respond(new Request(initial, { headers: { "if-none-match": tag } }), { version: "v1" });
    expect(response.status).toBe(304);
    expect(after).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
  });

  it("returns authentication errors even for a wildcard validator", async () => {
    const denied = privateHandler(async (req: Request) => {
      expect(req.headers.get("if-none-match")).toBe("*");
      throw new AuthError();
    });
    const response = await denied(request("sw_session=a", "*"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authenticated" });
  });
});
