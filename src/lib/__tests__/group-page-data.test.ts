import { describe, expect, it } from "vitest";
import { finishGroupExpensePage, groupExpensePage } from "../group-expense-page";

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
});
