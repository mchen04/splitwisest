import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Reopening an expense right after editing it used to paint the details cached
// before the edit, and their Delete sent the old version, which the server
// refuses. These cover the read cache that decides what the details show.

type Client = typeof import("../client");

const STORE_KEY = "splitwisest.read-cache.v1";
const RECORD = "/api/expenses/7";
const HISTORY = "/api/expenses/7/history";
const COMMENTS = "/api/expenses/7/comments";
const before = { expense: { id: 7, amountCents: 5200, updatedAt: "2026-10-09T10:00:00.000001Z" } };
const after = { expense: { id: 7, amountCents: 6123, updatedAt: "2026-10-09T10:00:05.000001Z" } };

let store: Map<string, string>;
let server: Map<string, unknown>;
type Deliver = (body: unknown) => void;
/** A read held open: the handler receives the function that answers it. */
let held: Map<string, (deliver: Deliver) => void>;
let fails: Set<string>;
let requests: string[];

function respond(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

beforeEach(() => {
  vi.resetModules();
  store = new Map();
  server = new Map<string, unknown>([[RECORD, before], [HISTORY, { edits: [] }], [COMMENTS, { comments: [] }]]);
  held = new Map();
  fails = new Set();
  requests = [];
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { cookie: "sw_cache_owner=u1", hidden: false });
  vi.stubGlobal("location", { pathname: "/groups/3", href: "" });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    requests.push(`${method} ${path}`);
    if (method !== "GET") return respond({ ok: true });
    if (fails.has(path)) throw new TypeError("Failed to fetch");
    const hold = held.get(path);
    if (hold) {
      held.delete(path);
      return new Promise((resolve) => hold((body) => resolve(respond(body))));
    }
    return server.has(path) ? respond(server.get(path)) : respond({ error: "Expense not found" }, 404);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Lets pending reads and the idle storage write run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function stored(): Map<string, unknown> {
  const raw = store.get(STORE_KEY);
  return new Map(raw ? (JSON.parse(raw).entries as [string, unknown, number][]).map(([path, value]) => [path, value]) : []);
}

/** Opens the details once so their reads are cached in memory and storage. */
async function viewed(client: Client) {
  await Promise.all([client.apiCached(RECORD), client.apiCached(HISTORY), client.apiCached(COMMENTS)]);
  await settle();
  expect(stored().get(RECORD)).toEqual(before);
}

/** The user's own edit as the expense form performs it. */
async function edit(client: Client) {
  await client.api(RECORD, { method: "PATCH", body: { amountCents: 6123 } });
  server.set(RECORD, after);
  client.refreshExpenseDetails(7);
}

describe("expense details after this client's own edit", () => {
  it("drops the pre-edit details at once, in memory and in storage", async () => {
    const client = await import("../client");
    await viewed(client);
    held.set(RECORD, () => {});
    held.set(HISTORY, () => {});

    await edit(client);

    // Nothing is left that could paint $52 or send its version, even if the
    // page reloads before the fresh read returns.
    expect(client.cacheGet(RECORD)).toBeNull();
    expect(stored().has(RECORD)).toBe(false);
    expect(stored().has(HISTORY)).toBe(false);
  });

  it("caches the saved details, so a reload paints the edited amount and its version", async () => {
    const client = await import("../client");
    await viewed(client);

    await edit(client);
    await settle();

    expect(client.cacheGet(RECORD)).toEqual(after);
    expect(stored().get(RECORD)).toEqual(after);
    expect(requests.filter((r) => r === `GET ${RECORD}`)).toHaveLength(2);
  });

  it("serves a slow fresh read to whoever opens the details meanwhile", async () => {
    const client = await import("../client");
    await viewed(client);
    let release: Deliver = () => {};
    held.set(RECORD, (resolve) => { release = resolve; });

    await edit(client);
    const opened = client.apiCached(RECORD);
    release(after);

    await expect(opened).resolves.toEqual(after);
    // Opening shares the read the edit started instead of asking again.
    expect(requests.filter((r) => r === `GET ${RECORD}`)).toHaveLength(2);
  });

  it("keeps a read that started before the edit out of the cache", async () => {
    const client = await import("../client");
    await viewed(client);
    let releaseOld: Deliver = () => {};
    held.set(RECORD, (resolve) => { releaseOld = resolve; });
    const older = client.apiCached(RECORD, true);

    await edit(client);
    await settle();
    releaseOld(before);
    await older;
    await settle();

    expect(client.cacheGet(RECORD)).toEqual(after);
    expect(stored().get(RECORD)).toEqual(after);
  });

  it("leaves nothing to paint when the fresh read fails, so the details can say so and retry", async () => {
    const client = await import("../client");
    await viewed(client);
    fails.add(RECORD);

    await edit(client);
    await settle();
    expect(client.cacheGet(RECORD)).toBeNull();

    fails.delete(RECORD);
    await expect(client.apiCached(RECORD)).resolves.toEqual(after);
  });
});

describe("expense details after this client deletes the expense", () => {
  it("forgets the record, its history and its comments", async () => {
    const client = await import("../client");
    await viewed(client);

    client.forgetExpenseDetails(7);

    for (const path of [RECORD, HISTORY, COMMENTS]) {
      expect(client.cacheGet(path)).toBeNull();
      expect(stored().has(path)).toBe(false);
    }
  });

  it("keeps a read in flight from writing the deleted expense back", async () => {
    const client = await import("../client");
    await viewed(client);
    let releaseOld: Deliver = () => {};
    held.set(RECORD, (resolve) => { releaseOld = resolve; });
    const older = client.apiCached(RECORD, true);

    client.forgetExpenseDetails(7);
    server.delete(RECORD);
    releaseOld(before);
    await older;
    await settle();

    expect(client.cacheGet(RECORD)).toBeNull();
    expect(stored().has(RECORD)).toBe(false);
  });

  it("does not hand a read from before the delete to the next look", async () => {
    const client = await import("../client");
    await viewed(client);
    let releaseOld: Deliver = () => {};
    held.set(RECORD, (resolve) => { releaseOld = resolve; });
    const older = client.apiCached(RECORD, true);

    client.forgetExpenseDetails(7);
    server.delete(RECORD);
    const opened = expect(client.apiCached(RECORD)).rejects.toThrow("Expense not found");
    releaseOld(before);
    await older;

    await opened;
  });
});

describe("what a read hook shows when the details open", () => {
  it("paints the cached details on first open", async () => {
    const { stateOnShow } = await import("../client");
    const first = { path: RECORD, data: null, error: null, status: null, settled: false };

    expect(stateOnShow(first, RECORD, after)).toEqual({ path: RECORD, data: after, error: null, status: null, settled: false });
    expect(stateOnShow(first, RECORD, null)).toBe(first);
  });

  it("keeps its own state when the cache still holds the same read", async () => {
    const { stateOnShow } = await import("../client");
    const shown = { path: RECORD, data: before, error: null, status: 200, settled: true };

    expect(stateOnShow(shown, RECORD, before)).toBe(shown);
  });

  it("follows a newer cached read instead of the copy it showed before the edit", async () => {
    const { stateOnShow } = await import("../client");
    const shown = { path: RECORD, data: before, error: null, status: 200, settled: true };

    expect(stateOnShow(shown, RECORD, after).data).toBe(after);
  });

  it("drops the copy it showed before the edit when the cache forgot it", async () => {
    const { stateOnShow } = await import("../client");
    const shown = { path: RECORD, data: before, error: null, status: 200, settled: true };

    expect(stateOnShow(shown, RECORD, null)).toEqual({ path: RECORD, data: null, error: null, status: null, settled: false });
  });

  it("does not touch another path's state when nothing is cached", async () => {
    const { stateOnShow } = await import("../client");
    const other = { path: "/api/expenses/8", data: before, error: null, status: 200, settled: true };

    expect(stateOnShow(other, RECORD, null)).toBe(other);
  });
});

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("expense edit and delete wiring", () => {
  const form = source("src/components/expense-form.tsx");
  const page = source("src/app/groups/[id]/page.tsx");
  const detail = source("src/components/expense-detail.tsx");
  const deleteExpense = page.split("async function deleteExpense")[1].split("\n  async function ")[0];

  it("refreshes the details right after an edit is saved, and again after its receipts upload", () => {
    const patch = form.indexOf('method: "PATCH"');

    expect(form.indexOf("refreshExpenseDetails(expenseId)", patch)).toBeGreaterThan(patch);
    expect(form.indexOf("refreshExpenseDetails(expenseId)", patch)).toBeLessThan(form.indexOf("} else {", patch));
    expect(form).toMatch(/finally \{[\s\S]*?!createdNewExpense && files\.length > 0\) refreshExpenseDetails\(expenseId\)/);
  });

  it("still sends the version shown, so a changed expense is refused rather than deleted", () => {
    expect(deleteExpense).toContain("expectedUpdatedAt=${encodeURIComponent(expense.updatedAt)}");
    expect(deleteExpense).not.toMatch(/api(Cached)?<[^>]*>\(`\/api\/expenses\/\$\{expense\.id\}`\)/);
    expect(source("src/lib/expenses.ts")).toContain('if (!expense.expectedUpdatedAt) badRequest("Expense changed, refresh and try again")');
  });

  it("forgets deleted details and rereads them after a refusal", () => {
    expect(deleteExpense.indexOf("forgetExpenseDetails(expense.id)")).toBeGreaterThan(deleteExpense.indexOf('method: "DELETE"'));
    expect(deleteExpense.indexOf("forgetExpenseDetails(expense.id)")).toBeLessThan(deleteExpense.indexOf("catch (err)"));
    expect(deleteExpense.split("catch (err)")[1]).toContain("if (err instanceof ApiClientError) refreshExpenseDetails(expense.id)");
  });

  it("keeps deleting from details that the list page does not hold", () => {
    expect(detail).toContain("onClick={() => onDelete(detail)}");
    expect(page).toMatch(/onDelete=\{\(expense\) => \{\s*setDetailId\(null\);\s*void deleteExpense\(expense\);/);
  });

  it("reads details from the same paths the cache refreshes", () => {
    const client = source("src/lib/client.ts");

    for (const path of ["`/api/expenses/${expenseId ?? 0}`", "`/api/expenses/${expenseId ?? 0}/history`", "`/api/expenses/${expenseId ?? 0}/comments`"]) {
      expect(detail).toContain(path);
    }
    expect(client).toContain("[`/api/expenses/${id}`, `/api/expenses/${id}/history`]");
    expect(client).toContain("`/api/expenses/${id}/comments`");
  });
});
