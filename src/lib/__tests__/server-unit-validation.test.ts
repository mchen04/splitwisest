import { beforeEach, describe, expect, it, vi } from "vitest";

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock("../db", () => ({ sql }));

import { ExpenseBody, validateExpenseShares } from "../expenses";
import { requireGroupUnit } from "../group-units";
import { settlementFields } from "../settlements";

const base = {
  title: "Drinks",
  amountCents: 100,
  currency: "USD",
  unitId: 9,
  date: "2026-11-14",
  payerId: 1,
  notes: "",
  splitMethod: "equal" as const,
  participants: [{ userId: 1 }, { userId: 2 }, { userId: 3 }],
};

beforeEach(() => {
  sql.mockReset();
});

describe("unit expense validation", () => {
  it("splits hundredths exactly for a unit", async () => {
    sql.mockResolvedValueOnce([{ id: "9", name: "drinks" }]);
    await requireGroupUnit(5, 9);
    expect(validateExpenseShares(new Set([1, 2, 3]), base)).toEqual(new Map([[1, 34], [2, 33], [3, 33]]));
  });

  it("uses the unit scale even when the group currency is zero-decimal", async () => {
    sql.mockResolvedValueOnce([{ id: "9", name: "drinks" }]);
    await requireGroupUnit(5, 9);
    expect(validateExpenseShares(new Set([1, 2, 3]), { ...base, currency: "JPY" }))
      .toEqual(new Map([[1, 34], [2, 33], [3, 33]]));
  });

  it("rejects a unit that does not belong to the group", async () => {
    sql.mockResolvedValueOnce([]);
    await expect(requireGroupUnit(5, 9)).rejects.toThrow("Unknown unit for this group");
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed unit ids before any query", () => {
    expect(ExpenseBody.safeParse({ ...base, unitId: 0 }).success).toBe(false);
    expect(ExpenseBody.safeParse({ ...base, unitId: "9" }).success).toBe(false);
    expect(ExpenseBody.safeParse({ ...base, unitId: null }).success).toBe(true);
  });

  it("accepts a unit on a settlement body and rejects a malformed one", () => {
    const body = { amountCents: 100, currency: "USD", unitId: 9, date: "2026-11-14", note: "" };
    expect(settlementFields.unitId.safeParse(body.unitId).success).toBe(true);
    expect(settlementFields.unitId.safeParse(0).success).toBe(false);
    expect(settlementFields.unitId.safeParse("9").success).toBe(false);
  });
});
