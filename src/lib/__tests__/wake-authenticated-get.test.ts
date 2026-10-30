import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options: { eager: true }): Record<string, T>;
  }
}

const { sql, transaction, jar, store } = vi.hoisted(() => {
  const jar = new Map<string, string>();
  const transaction = vi.fn(async (queries: unknown[]) => queries.map(() => []));
  const sql = Object.assign(vi.fn(async (strings: TemplateStringsArray) =>
    /WITH (viewer|me) AS/.test(strings.join("")) ? [{ viewer_id: null }] : []), { transaction });
  const store = {
    get: (key: string) => jar.has(key) ? { value: jar.get(key) } : undefined,
    set: vi.fn(),
    delete: vi.fn(),
  };
  return { sql, transaction, jar, store };
});

vi.mock("@/lib/db", () => ({ sql }));
vi.mock("next/headers", () => ({ cookies: async () => store }));

type Route = Partial<Record<"GET" | "POST" | "PATCH" | "DELETE", (...args: never[]) => Promise<Response>>>;
const modules = import.meta.glob<Route>("../../app/api/**/route.ts", { eager: true });
const routes = Object.entries(modules).filter(([path, route]) => route.GET
  && path !== "../../app/api/version/route.ts"
  && path !== "../../app/api/notifications/deliver/route.ts");
const malformed = [undefined, "", "bogus", "a".repeat(63), "a".repeat(65), "g".repeat(64),
  "A".repeat(64), `${"a".repeat(64)}\n`, `${"a".repeat(64)}\0`];
const prefetchHeaders: Record<string, string>[] = [
  { "next-router-prefetch": "1" },
  { purpose: "prefetch" },
  { "sec-purpose": "prefetch;prerender" },
];
const mutations = Object.entries(modules).flatMap(([path, route]) =>
  /\/auth\/(login|signup|recover)\/|\/notifications\/deliver\//.test(path) ? [] :
    (["POST", "PATCH", "DELETE"] as const).flatMap((method) => route[method] ? [[path, method, route[method]] as const] : []));

function request(path: string, headers: Record<string, string> = {}, method = "GET") {
  return new NextRequest(`http://localhost${path.replace("../../app", "").replace("/route.ts", "")
    .replace("[id]", "1").replace("[userId]", "2").replace("[friendId]", "2")}?id=1`, { headers, method });
}

const context = { params: Promise.resolve({ id: "1", userId: "2", friendId: "2" }) };

describe("authenticated GET requests leave sleeping compute alone", () => {
  beforeEach(() => {
    sql.mockClear();
    transaction.mockClear();
    store.set.mockClear();
    store.delete.mockClear();
    jar.clear();
  });

  it("covers every authenticated GET route", () => {
    expect(routes).toHaveLength(31);
  });

  describe.each(routes)("%s", (path, route) => {
    it.each(malformed)("rejects cookie %j without a database request", async (token) => {
      if (token !== undefined) jar.set("sw_session", token);
      const response = await route.GET!(request(path) as never, context as never);
      expect(response.status).toBe(401);
      expect(sql).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(store.set).not.toHaveBeenCalled();
    });

    it.each(prefetchHeaders)("does not query for prefetch headers %j", async (headers) => {
      jar.set("sw_session", "a".repeat(64));
      const response = await route.GET!(request(path, headers) as never, context as never);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(sql).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it("rejects an anonymous prefetch without a query", async () => {
      const response = await route.GET!(request(path, { purpose: "prefetch" }) as never, context as never);
      expect(response.status).toBe(401);
      expect(sql).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it("checks a well-formed unknown token against the database", async () => {
      jar.set("sw_session", "a".repeat(64));
      const response = await route.GET!(request(path) as never, context as never);
      expect(response.status).toBe(401);
      expect(sql).toHaveBeenCalled();
      expect(store.set).not.toHaveBeenCalled();
    });
  });

  it.each(mutations)("rejects anonymous or malformed-cookie mutation %s %s", async (path, method, mutate) => {
    for (const token of [undefined, "bogus"]) {
      if (token) jar.set("sw_session", token);
      const response = await mutate!(request(path, {}, method) as never, context as never);
      expect(response.status).toBe(401);
      expect(sql).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    }
  });

  it.each(malformed)("serves the public version without querying for cookie %j", async (token) => {
    if (token !== undefined) jar.set("sw_session", token);
    const response = modules["../../app/api/version/route.ts"].GET!();
    expect((await response).status).toBe(200);
    expect(sql).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(malformed)("clears a malformed session without querying for cookie %j", async (token) => {
    if (token !== undefined) jar.set("sw_session", token);
    const { clearSession } = await import("../auth");
    await clearSession();
    expect(sql).not.toHaveBeenCalled();
    expect(store.delete).toHaveBeenCalledWith("sw_session");
    expect(store.delete).toHaveBeenCalledWith("sw_cache_owner");
  });
});
