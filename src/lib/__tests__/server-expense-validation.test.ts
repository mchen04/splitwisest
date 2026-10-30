import { beforeEach, describe, expect, it, vi } from "vitest";

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));

vi.mock("../db", () => ({ sql }));

import { validateExpense, validateExpenseActors } from "../expenses";

const input = {
  title: "Lunch",
  amountCents: 1001,
  currency: "USD",
  date: "2026-10-25",
  payerId: 1,
  categoryId: 7,
  notes: "",
  splitMethod: "equal" as const,
  participants: [{ userId: 1 }, { userId: 2 }, { userId: 3 }],
};

beforeEach(() => {
  sql.mockReset();
  sql.mockResolvedValue([1, 2, 3].map((id) => ({ user_id: String(id), category_allowed: true })));
});

describe("expense actor validation", () => {
  it("validates members and the category in one database request", async () => {
    expect(await validateExpenseActors(5, 1, input)).toEqual(new Set([1, 2, 3]));
    expect(sql).toHaveBeenCalledTimes(1);
    expect(sql.mock.calls[0].slice(1)).toEqual([7, 1, 5]);
  });

  it.each([null, undefined])("accepts an expense without a category: %s", async (categoryId) => {
    expect(await validateExpenseActors(5, 1, { ...input, categoryId })).toEqual(new Set([1, 2, 3]));
    expect(sql).toHaveBeenCalledTimes(1);
    expect(sql.mock.calls[0].slice(1)).toEqual([5]);
  });

  it("rejects a category that the viewer cannot use", async () => {
    sql.mockResolvedValue([1, 2, 3].map((user_id) => ({ user_id, category_allowed: false })));
    await expect(validateExpenseActors(5, 1, input)).rejects.toThrow("Unknown category");
  });

  it("rejects a payer outside the group before checking the category", async () => {
    sql.mockResolvedValue([{ user_id: 2, category_allowed: false }]);
    await expect(validateExpenseActors(5, 1, input)).rejects.toThrow("Payer must be a group member");
  });

  it("rejects a participant outside the group before checking the category", async () => {
    sql.mockResolvedValue([{ user_id: 1, category_allowed: false }]);
    await expect(validateExpenseActors(5, 1, input)).rejects.toThrow("All participants must be group members");
  });

  it("rejects duplicate participants before checking the category", async () => {
    sql.mockResolvedValue([{ user_id: 1, category_allowed: false }]);
    await expect(validateExpenseActors(5, 1, { ...input, participants: [{ userId: 1 }, { userId: 1 }] }))
      .rejects.toThrow("Duplicate participants");
  });

  it("rejects a group with no members", async () => {
    sql.mockResolvedValue([]);
    await expect(validateExpenseActors(5, 1, input)).rejects.toThrow("Payer must be a group member");
  });

  it("validates recurring participant IDs", async () => {
    await expect(validateExpenseActors(5, 1, { payerId: 1, categoryId: 7, participantIds: [1, 12] }))
      .rejects.toThrow("All participants must be group members");
  });

  it("preserves cent allocation", async () => {
    expect(await validateExpense(5, 1, input)).toEqual(new Map([[1, 334], [2, 334], [3, 333]]));
  });

  it("rejects fractional yen", async () => {
    await expect(validateExpense(5, 1, { ...input, currency: "JPY" })).rejects.toThrow();
  });

  it("rejects undeclared item participants", async () => {
    await expect(validateExpense(5, 1, {
      ...input,
      splitMethod: "itemized",
      participants: [{ userId: 1 }],
      items: [{ name: "Lunch", amountCents: 1001, participantIds: [2] }],
    })).rejects.toThrow("Item participants must be expense participants");
  });
});
