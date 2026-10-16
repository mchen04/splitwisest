import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = vi.fn();
const jar = new Map<string, string>();
const store = {
  get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
  set: vi.fn((name: string, value: string) => { jar.set(name, value); }),
};
vi.mock("@/lib/db", () => ({ sql }));
vi.mock("next/headers", () => ({ cookies: async () => store }));

const versionRoute = await import("@/app/api/groups/[id]/version/route");
const syncRoute = await import("@/app/api/sync/route");
const detailRoute = await import("@/app/api/groups/[id]/route");
const listRoute = await import("@/app/api/groups/[id]/group-balances/route");

const groupRow = { viewer_id: 5, id: 7, name: "Trip", currency: "USD", invite_code: "x", created_by: 5, is_member: true,
  detail_version: "d", list_version: "l", recurring_due: false };
const version = (id: string) => versionRoute.GET(new Request(`https://app.example/api/groups/${id}/version`) as never,
  { params: Promise.resolve({ id }) });

describe("polling routes check the session in their own statement", () => {
  beforeEach(() => { sql.mockReset(); store.set.mockClear(); jar.clear(); });

  it("answers 401 without a query when the cookie is missing", async () => {
    expect((await version("7")).status).toBe(401);
    expect((await syncRoute.GET()).status).toBe(401);
    expect(sql).not.toHaveBeenCalled();
  });

  it("answers 401 before 404 or 403 when the session is not valid", async () => {
    jar.set("sw_session", "t");
    sql.mockResolvedValue([{ ...groupRow, viewer_id: null, id: null, is_member: false }]);
    expect((await version("7")).status).toBe(401);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("answers 404 for a missing group and 403 for a non-member, refreshing the owner cookie", async () => {
    jar.set("sw_session", "t");
    sql.mockResolvedValueOnce([{ ...groupRow, id: null, is_member: false }]);
    expect((await version("7")).status).toBe(404);
    sql.mockResolvedValueOnce([{ ...groupRow, is_member: false }]);
    expect((await version("7")).status).toBe(403);
    expect(jar.get("sw_cache_owner")).toBe("5");
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it("returns fingerprints for a member in one query", async () => {
    jar.set("sw_session", "t");
    sql.mockResolvedValueOnce([groupRow]);
    const res = await version("7");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ detail: "d", list: "l", recurringDue: false });
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("returns group data and its fingerprint from the same snapshot", async () => {
    jar.set("sw_session", "t");
    sql.mockResolvedValueOnce([{ ...groupRow,
      members: [{ id: 5, display_name: "A", username: "a" }, { id: 6, display_name: "B", username: "b" }],
      balances: [{ user_id: 5, display_name: "A", net_cents: 50 }, { user_id: 6, display_name: "B", net_cents: -50 }],
    }]).mockResolvedValueOnce([]);
    const response = await detailRoute.GET(new Request("https://app.example/api/groups/7") as never,
      { params: Promise.resolve({ id: "7" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: "d",
      members: [{ id: 5, displayName: "A", username: "a" }, { id: 6, displayName: "B", username: "b" }],
      balances: [{ userId: 5, displayName: "A", netCents: 50 }, { userId: 6, displayName: "B", netCents: -50 }],
      suggestions: [{ from: 6, to: 5, amountCents: 50 }],
    });
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it("refreshes the snapshot after materializing due recurring expenses", async () => {
    jar.set("sw_session", "t");
    sql.mockResolvedValueOnce([{ ...groupRow, recurring_due: true }]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...groupRow, detail_version: "new",
        balances: [{ user_id: 5, display_name: "A", net_cents: 0 }],
        members: [{ id: 5, display_name: "A", username: "a" }],
      }]);
    const response = await detailRoute.GET(new Request("https://app.example/api/groups/7") as never,
      { params: Promise.resolve({ id: "7" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: "new", balances: [{ userId: 5, netCents: 0 }] });
    expect(sql).toHaveBeenCalledTimes(3);
  });

  it("checks the session first for a malformed id", async () => {
    jar.set("sw_session", "t");
    sql.mockResolvedValueOnce([]);
    expect((await version("abc")).status).toBe(401);
    sql.mockResolvedValueOnce([{ id: 5, username: "a", display_name: "A", invite_code: "i" }]);
    expect((await version("abc")).status).toBe(404);
  });

  it("answers sync 401 when its session row is missing", async () => {
    jar.set("sw_session", "t");
    sql.mockResolvedValueOnce([{ viewer_id: null }]);
    expect((await syncRoute.GET()).status).toBe(401);
    expect(store.set).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid session", { viewer_id: null, id: null, is_member: false }, 401],
    ["missing group", { id: null, is_member: false }, 404],
    ["non-member", { is_member: false }, 403],
  ])("detail and list stop after one query for a %s (no recurring writes)", async (_name, row, status) => {
    jar.set("sw_session", "t");
    sql.mockResolvedValue([{ ...groupRow, ...row }]);
    const ctx = { params: Promise.resolve({ id: "7" }) };
    expect((await detailRoute.GET(new Request("https://app.example/api/groups/7") as never, ctx)).status).toBe(status);
    expect((await listRoute.GET(new NextRequest("https://app.example/api/groups/7/group-balances?limit=50"), ctx)).status).toBe(status);
    expect(sql).toHaveBeenCalledTimes(2);
  });
});
