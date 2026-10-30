import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sql, transaction, materialize, jar } = vi.hoisted(() => {
  const transaction = vi.fn();
  return {
    sql: Object.assign(vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      text: strings.join("?"), values,
    })), { transaction }),
    transaction,
    materialize: vi.fn(),
    jar: new Map<string, string>(),
  };
});

vi.mock("@/lib/db", () => ({ sql }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (key: string) => jar.has(key) ? { value: jar.get(key) } : undefined,
  set: (key: string, value: string) => jar.set(key, value),
}) }));
vi.mock("@/lib/expenses", async (original) => ({
  ...await original<typeof import("@/lib/expenses")>(), materializeRecurring: materialize,
}));

const activity = await import("@/app/api/groups/[id]/activity/route");
const expenses = await import("@/app/api/groups/[id]/expenses/route");
const viewer = { id: "7", username: "alice", display_name: "Alice", invite_code: "invite" };
const group = { id: "1", name: "Trip", currency: "USD", invite_code: "group-invite", created_by: "7", is_member: true, recurring_due: false };
const request = () => new NextRequest("http://localhost/api/groups/1/activity");
const context = (id = "1") => ({ params: Promise.resolve({ id }) });

describe("batched group reads", () => {
  beforeEach(() => {
    sql.mockClear();
    transaction.mockReset();
    materialize.mockReset();
    jar.clear();
    jar.set("sw_session", "session");
  });

  it("checks the session and membership and returns data in one request", async () => {
    transaction.mockResolvedValueOnce([[viewer], [group], []]);
    const response = await activity.GET(request(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activity: [] });
    expect(transaction).toHaveBeenCalledOnce();
    const queries = transaction.mock.calls[0][0];
    expect(queries).toHaveLength(3);
    expect(queries[2].values[0].text).toContain("FROM group_members");
    expect(jar.get("sw_cache_owner")).toBe("7");
  });

  it.each([
    [[], [], 401],
    [[viewer], [], 404],
    [[viewer], [{ ...group, is_member: false }], 403],
  ])("preserves error priority for session %j and group %j", async (users, groups, status) => {
    transaction.mockResolvedValueOnce([users, groups, [{ id: 2, summary: "private" }]]);
    const response = await activity.GET(request(), context());
    expect(response.status).toBe(status);
    expect(await response.json()).not.toHaveProperty("activity");
  });

  it("does not query with a missing session cookie", async () => {
    jar.clear();
    expect((await activity.GET(request(), context())).status).toBe(401);
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([false, true])("only materializes recurring expenses when due is %s", async (due) => {
    transaction.mockImplementationOnce(async () => {
      sql.mockResolvedValueOnce([] as never);
      return [[viewer], [{ ...group, recurring_due: due }]];
    });
    materialize.mockResolvedValue(undefined);
    const response = await expenses.GET(new NextRequest("http://localhost/api/groups/1/expenses"), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hasMore: false, expenses: [] });
    expect(materialize).toHaveBeenCalledTimes(due ? 1 : 0);
    expect(transaction).toHaveBeenCalledOnce();
  });
});
