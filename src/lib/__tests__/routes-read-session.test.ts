import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { sql, transaction, jar, store } = vi.hoisted(() => {
  const jar = new Map<string, string>();
  const transaction = vi.fn();
  const sql = Object.assign(vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join("?"), values,
  })), { transaction });
  const store = {
    get: (key: string) => jar.has(key) ? { value: jar.get(key) } : undefined,
    set: vi.fn((key: string, value: string) => jar.set(key, value)),
  };
  return { sql, transaction, jar, store };
});

vi.mock("@/lib/db", () => ({ sql }));
vi.mock("next/headers", () => ({ cookies: async () => store }));

const { readSession } = await import("@/app/api/_lib/read-session");
const categories = await import("@/app/api/categories/route");
const notification = await import("@/app/api/notifications/[id]/route");
const pushTest = await import("@/app/api/push/test/route");
const viewer = { id: "7", username: "alice", display_name: "Alice", invite_code: "invite" };

describe("batched authenticated reads", () => {
  beforeEach(() => {
    sql.mockClear();
    transaction.mockReset();
    store.set.mockClear();
    jar.clear();
    jar.set("sw_session", "session");
  });

  it("returns the same category fields in one database request", async () => {
    transaction.mockResolvedValueOnce([[viewer], [
      { id: "3", name: "Food", icon: "utensils", owner_id: null },
      { id: "4", name: "Books", icon: "tag", owner_id: "7" },
    ]]);
    const response = await categories.GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ categories: [
      { id: 3, name: "Food", icon: "utensils", custom: false },
      { id: 4, name: "Books", icon: "tag", custom: true },
    ] });
    expect(transaction).toHaveBeenCalledOnce();
    const [queries, options] = transaction.mock.calls[0];
    expect(queries).toHaveLength(2);
    expect(options).toEqual({ isolationLevel: "RepeatableRead", readOnly: true });
    expect(queries[1].values[0].text).toContain("s.expires_at > now()");
    expect(queries[1].values[0].text).toContain("u.deleted_at IS NULL");
    expect(jar.get("sw_cache_owner")).toBe("7");
  });

  it("rejects a missing cookie without a database request", async () => {
    jar.clear();
    expect((await categories.GET()).status).toBe(401);
    expect(transaction).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it("never returns rows when the session is expired or deleted", async () => {
    transaction.mockResolvedValueOnce([[], [{ id: "3", name: "private" }]]);
    const response = await categories.GET();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authenticated" });
    expect(store.set).not.toHaveBeenCalled();
  });

  it("preserves authentication priority when a data query fails", async () => {
    transaction.mockImplementationOnce(async () => {
      sql.mockResolvedValueOnce([] as never);
      throw new Error("invalid bigint");
    });
    expect((await categories.GET()).status).toBe(401);
  });

  it("preserves the data error and access check for an authenticated session", async () => {
    const error = new Error("data unavailable");
    const checkAccess = vi.fn().mockResolvedValue(undefined);
    transaction.mockImplementationOnce(async () => {
      sql.mockResolvedValueOnce([viewer] as never);
      throw error;
    });
    await expect(readSession(() => [], checkAccess)).rejects.toBe(error);
    expect(checkAccess).toHaveBeenCalledWith({
      id: 7, username: "alice", displayName: "Alice", inviteCode: "invite",
    });
  });

  it("returns notification details in one request without changing its cache policy", async () => {
    transaction.mockResolvedValueOnce([[viewer], [{
      id: "3", category: "messages", title: "Hello", body: "A message", href: "/chat",
      created_at: "2026-10-01T00:00:00Z", read_at: null,
    }]]);
    const response = await notification.GET(new NextRequest("http://localhost/api/notifications/3"),
      { params: Promise.resolve({ id: "3" }) });
    expect(await response.json()).toEqual({ notification: {
      id: 3, category: "messages", title: "Hello", body: "A message", href: "/chat",
      createdAt: "2026-10-01T00:00:00Z", readAt: null,
    } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("keeps the deleted-expense notification fallback", async () => {
    transaction.mockImplementationOnce(async () => {
      sql.mockResolvedValueOnce([] as never);
      return [[viewer], [{
        id: "3", category: "expenses", title: "Dinner", body: "An expense", href: "/groups/1?expense=2",
        group_id: "1", created_at: "2026-10-01T00:00:00Z", read_at: null,
      }]];
    });
    const response = await notification.GET(new NextRequest("http://localhost/api/notifications/3"),
      { params: Promise.resolve({ id: "3" }) });
    expect(await response.json()).toMatchObject({ notification: { href: "/groups/1?tab=activity" } });
  });

  it("returns delivery state in one request", async () => {
    transaction.mockResolvedValueOnce([[viewer], [{ state: "sent", attempts: "2" }]]);
    const response = await pushTest.GET(new NextRequest("http://localhost/api/push/test?id=3"));
    expect(await response.json()).toEqual({ state: "sent", attempts: 2 });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(transaction).toHaveBeenCalledOnce();
  });

  it.each(["notification", "delivery state"])("rejects an expired session before returning %s", async (kind) => {
    transaction.mockResolvedValueOnce([[], [{ id: "3", state: "sent" }]]);
    const response = kind === "notification"
      ? await notification.GET(new NextRequest("http://localhost/api/notifications/3"), { params: Promise.resolve({ id: "3" }) })
      : await pushTest.GET(new NextRequest("http://localhost/api/push/test?id=3"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authenticated" });
  });
});
