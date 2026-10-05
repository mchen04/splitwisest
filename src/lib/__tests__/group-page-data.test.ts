import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finishGroupExpensePage, groupExpensePage } from "../group-expense-page";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("group expense data", () => {
  it("returns every expense for the complete insights request", () => {
    const request = groupExpensePage(new URLSearchParams("all=1&limit=2&offset=3"));
    const expenses = Array.from({ length: 250 }, (_, id) => ({ id }));

    expect(request).toEqual({ complete: true, limit: 2, offset: 0, sqlLimit: null });
    expect(finishGroupExpensePage(expenses, request)).toEqual({ hasMore: false, items: expenses });
  });

  it("keeps the visible expense list bounded", () => {
    const request = groupExpensePage(new URLSearchParams("limit=2&offset=3"));
    const expenses = [{ id: 1 }, { id: 2 }, { id: 3 }];

    expect(request).toEqual({ complete: false, limit: 2, offset: 3, sqlLimit: 3 });
    expect(finishGroupExpensePage(expenses, request)).toEqual({
      hasMore: true,
      items: expenses.slice(0, 2),
    });
  });

  it("loads insights from a separate complete expense request", () => {
    const data = source("src/app/groups/[id]/use-group-page-data.ts");
    const page = source("src/app/groups/[id]/page.tsx");

    expect(data).toContain("insightExpenses");
    expect(data).toContain("/expenses?all=1");
    expect(page).toContain("<SpendCharts expenses={insightExpenses}");
  });

  it("materializes recurring expenses before each expense response", () => {
    const route = source("src/app/api/groups/[id]/expenses/route.ts");

    expect(route).toContain("await materializeRecurring(groupId)");
    expect(route.indexOf("await materializeRecurring(groupId)")).toBeLessThan(route.indexOf("const rows = await sql"));
  });

  it("reads group fingerprints before the data they describe", () => {
    const detail = source("src/app/api/groups/[id]/route.ts");
    const list = source("src/app/api/groups/[id]/group-balances/route.ts");
    const detailVersion = detail.indexOf("await requireGroupMemberVersions(groupId");
    const listVersion = list.indexOf("await requireGroupMemberVersions(groupId");

    expect(detailVersion).toBeGreaterThan(-1);
    expect(detailVersion).toBeLessThan(detail.indexOf("await materializeRecurring(groupId)"));
    expect(listVersion).toBeGreaterThan(-1);
    expect(listVersion).toBeLessThan(list.indexOf("const rows = await sql"));
  });
});
