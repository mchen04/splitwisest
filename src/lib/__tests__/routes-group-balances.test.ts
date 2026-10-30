import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sql, jar } = vi.hoisted(() => ({ sql: vi.fn(), jar: new Map<string, string>() }));
vi.mock("@/lib/db", () => ({ sql }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (key: string) => jar.has(key) ? { value: jar.get(key) } : undefined,
  set: (key: string, value: string) => jar.set(key, value),
}) }));

const { GET } = await import("@/app/api/groups/[id]/group-balances/route");
const row = { viewer_id: "7", id: "1", is_member: true, list_version: "version", change_cursor: "81", balances: [] };
const request = (query = "") => GET(new NextRequest(`http://localhost/api/groups/1/group-balances${query}`),
  { params: Promise.resolve({ id: "1" }) });

describe("group balance list snapshot", () => {
  beforeEach(() => {
    sql.mockReset();
    jar.clear();
    jar.set("sw_session", "a".repeat(64));
  });

  it("returns the version, cursor and bounded page from one request", async () => {
    sql.mockResolvedValueOnce([{ ...row, balances: [
      { id: "3", title: "Third", amount_cents: "501", updated_at_token: "2026-10-01T00:00:00.000001Z" },
      { id: "2", title: "Second", amount_cents: "499", updated_at_token: "2026-10-01T00:00:00.000002Z" },
      { id: "1", title: "First", amount_cents: "1000", updated_at_token: "2026-10-01T00:00:00.000003Z" },
    ] }]);
    const response = await request("?limit=2");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: "version", changeCursor: 81, hasMore: true, balances: [
      { id: 3, title: "Third", amountCents: 501, updatedAt: "2026-10-01T00:00:00.000001Z" },
      { id: 2, title: "Second", amountCents: 499, updatedAt: "2026-10-01T00:00:00.000002Z" },
    ] });
    expect(sql).toHaveBeenCalledOnce();
    expect(jar.get("sw_cache_owner")).toBe("7");
  });

  it.each([
    [{ viewer_id: null, id: null, is_member: false }, 401],
    [{ id: null, is_member: false }, 404],
    [{ is_member: false }, 403],
  ])("keeps access errors ahead of invalid pagination %j", async (access, status) => {
    sql.mockResolvedValueOnce([{ ...row, ...access }]);
    const response = await request("?limit=invalid&before=invalid");
    expect(response.status).toBe(status);
    expect(await response.json()).not.toHaveProperty("balances");
  });

  it.each(["?limit=invalid", "?limit=1.5", "?before=0", "?before=invalid", "?before=-1"])("rejects invalid pagination %s", async (query) => {
    sql.mockResolvedValueOnce([row]);
    expect((await request(query)).status).toBe(400);
    expect(sql).toHaveBeenCalledOnce();
  });

  it("does not query with a missing cookie", async () => {
    jar.clear();
    expect((await request()).status).toBe(401);
    expect(sql).not.toHaveBeenCalled();
  });
});
