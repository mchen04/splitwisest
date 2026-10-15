import { describe, expect, it } from "vitest";
import { clearAllDrafts, clearDraft, readDraft, writeDraft } from "../drafts";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

describe("persistent drafts", () => {
  it("round-trips a draft for its owner only", () => {
    const store = memoryStorage();
    writeDraft(1, "chat:/api/groups/2/messages", "see you at 8", 1000, store);
    expect(readDraft(1, "chat:/api/groups/2/messages", 2000, store)).toBe("see you at 8");
    expect(readDraft(2, "chat:/api/groups/2/messages", 2000, store)).toBeNull();
    expect(readDraft(1, "chat:/api/groups/3/messages", 2000, store)).toBeNull();
  });

  it("keeps structured form drafts", () => {
    const store = memoryStorage();
    const draft = { groupId: 4, amount: "12.34", title: "Taxi", participants: [1, 2] };
    writeDraft(7, "expense:new", draft, 1000, store);
    expect(readDraft(7, "expense:new", 1000, store)).toEqual(draft);
  });

  it("drops an empty draft instead of storing it", () => {
    const store = memoryStorage();
    writeDraft(1, "comment:9", "hello", 1000, store);
    writeDraft(1, "comment:9", "", 1000, store);
    expect(store.map.size).toBe(0);
    writeDraft(1, "comment:9", "again", 1000, store);
    clearDraft(1, "comment:9", store);
    expect(store.map.size).toBe(0);
  });

  it("expires drafts older than a week and removes them", () => {
    const store = memoryStorage();
    writeDraft(1, "expense:new", { amount: "5" }, 0, store);
    expect(readDraft(1, "expense:new", 7 * 24 * 60 * 60 * 1000, store)).toEqual({ amount: "5" });
    expect(readDraft(1, "expense:new", 7 * 24 * 60 * 60 * 1000 + 1, store)).toBeNull();
    expect(store.map.size).toBe(0);
  });

  it("ignores corrupt entries", () => {
    const store = memoryStorage();
    store.setItem("splitwisest.draft.1.chat:x", "{not json");
    expect(readDraft(1, "chat:x", 0, store)).toBeNull();
  });

  it("clears every draft on sign-out but leaves other app data", () => {
    const store = memoryStorage();
    writeDraft(1, "a", "x", 0, store);
    writeDraft(2, "b", "y", 0, store);
    store.setItem("splitwisest.lastExpenseGroup", "3");
    clearAllDrafts(store);
    expect([...store.map.keys()]).toEqual(["splitwisest.lastExpenseGroup"]);
  });
});
