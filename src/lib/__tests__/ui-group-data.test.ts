import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGroupPageData } from "@/app/groups/[id]/use-group-page-data";

const reads = vi.hoisted(() => ({
  options: new Map<string, { enabled?: boolean }>(),
  reloads: new Map<string, ReturnType<typeof vi.fn>>(),
  sync: null as null | ((current: { activityCursor: number; messageCursor: number }, previous: { activityCursor: number; messageCursor: number }) => void),
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => [initial, vi.fn()],
}));

vi.mock("@/lib/client", () => ({
  useApiData: (path: string, _delay: number, options: { enabled?: boolean }) => {
    reads.options.set(path, options);
    const reload = vi.fn();
    reads.reloads.set(path, reload);
    return { data: null, error: null, settled: false, reload, reloadFresh: reload, reloadFreshCoalesced: reload };
  },
  useSync: (callback: typeof reads.sync) => { reads.sync = callback; },
}));

beforeEach(() => {
  reads.options.clear();
  reads.reloads.clear();
  reads.sync = null;
});

function TestGroupData(activityEnabled: boolean, balancesEnabled: boolean) {
  const options = { groupId: 1, filters: { q: "", cat: "", payer: "", from: "", to: "" },
    expenseLimit: 50, settlementLimit: 50, insightsEnabled: false, activityEnabled, balancesEnabled };
  return useGroupPageData(options);
}

describe("group tab reads", () => {
  it("does not load unopened activity or settlement history during refreshes", () => {
    const data = TestGroupData(false, false);
    expect(reads.options.get("/api/groups/1/activity")?.enabled).toBe(false);
    expect(reads.options.get("/api/groups/1/settlements?limit=50")?.enabled).toBe(false);
    data.refreshAll(true);
    reads.sync?.({ activityCursor: 2, messageCursor: 0 }, { activityCursor: 1, messageCursor: 0 });
    expect(reads.reloads.get("/api/groups/1/activity")).not.toHaveBeenCalled();
    expect(reads.reloads.get("/api/groups/1/settlements?limit=50")).not.toHaveBeenCalled();
    expect(reads.reloads.get("/api/groups/1")).toHaveBeenCalledTimes(2);
    expect(reads.reloads.get("/api/groups/1/expenses?limit=50")).toHaveBeenCalledTimes(2);
  });

  it("loads and refreshes history while its tab is open", () => {
    const data = TestGroupData(true, true);
    expect(reads.options.get("/api/groups/1/activity")?.enabled).not.toBe(false);
    expect(reads.options.get("/api/groups/1/settlements?limit=50")?.enabled).not.toBe(false);
    data.refreshAll();
    expect(reads.reloads.get("/api/groups/1/activity")).toHaveBeenCalledOnce();
    expect(reads.reloads.get("/api/groups/1/settlements?limit=50")).toHaveBeenCalledOnce();
  });
});
