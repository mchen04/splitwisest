import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "splitwisest.read-cache.v1";
const PATH = "/api/groups/1";
const OLD_DETAIL = {
  group: { id: 1, name: "Old group", currency: "USD" },
  members: [{ id: 1, displayName: "Ann" }],
  balances: [],
  suggestions: [],
};
const DRAFT_KEY = "splitwisest.draft.1.expense:new";
const PUSH_KEY = "splitwisest.push-device";

let store: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_BUILD_ID = "build-b";
  store = new Map();
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { cookie: "sw_cache_owner=u1" });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_BUILD_ID;
});

function seed(payload: unknown) {
  store.set(KEY, JSON.stringify(payload));
}

describe("persisted read cache build identity", () => {
  it("discards the old v1 payload that has no build identity", async () => {
    seed({ owner: "u1", entries: [[PATH, OLD_DETAIL, Date.now()]] });
    const client = await import("../client");

    client.hydrateReadCache();

    expect(client.cacheGet(PATH)).toBeNull();
    expect(store.has(KEY)).toBe(false);
  });

  it("serves a same-build payload", async () => {
    seed({ owner: "u1", build: "build-b", entries: [[PATH, OLD_DETAIL, Date.now()]] });
    const client = await import("../client");

    client.hydrateReadCache();

    expect(client.cacheGet(PATH)).toEqual(OLD_DETAIL);
  });

  it("discards another account's same-build payload", async () => {
    seed({ owner: "u2", build: "build-b", entries: [[PATH, OLD_DETAIL, Date.now()]] });
    const client = await import("../client");

    client.hydrateReadCache();

    expect(client.cacheGet(PATH)).toBeNull();
    expect(store.has(KEY)).toBe(false);
  });

  it("leaves drafts and push-device storage untouched", async () => {
    seed({ owner: "u1", entries: [[PATH, OLD_DETAIL, Date.now()]] });
    store.set(DRAFT_KEY, JSON.stringify({ value: "half typed", savedAt: Date.now() }));
    store.set(PUSH_KEY, JSON.stringify({ userId: 1, id: 9 }));
    const client = await import("../client");

    client.hydrateReadCache();

    expect(store.has(DRAFT_KEY)).toBe(true);
    expect(store.has(PUSH_KEY)).toBe(true);
  });

  it("writes the build identity so the next launch can read its own cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(OLD_DETAIL), {
      status: 200, headers: { "content-type": "application/json" },
    })));
    const client = await import("../client");

    await client.apiCached(PATH);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(JSON.parse(store.get(KEY) ?? "null")).toMatchObject({ owner: "u1", build: "build-b" });
    vi.resetModules();
    const next = await import("../client");
    expect(next.cacheGet(PATH)).toEqual(OLD_DETAIL);
  });
});
