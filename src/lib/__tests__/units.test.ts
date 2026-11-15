import { describe, expect, it } from "vitest";
import {
  computeUnitBalances, directedObligation, formatUnitAmount, formatUnitQuantity,
  normalizeUnitName, unitNameError, validateUnitRepayment,
} from "../units";

const ids = [1, 2, 3];

function expense(payerId: number, amountCents: number, shares: [number, number][]) {
  return { payerId, amountCents, shares: shares.map(([userId, shareCents]) => ({ userId, shareCents })) };
}

describe("unit formatting", () => {
  it("trims quantities and names without currency symbols", () => {
    expect(formatUnitQuantity(250)).toBe("2.5");
    expect(formatUnitQuantity(300)).toBe("3");
    expect(formatUnitQuantity(34)).toBe("0.34");
    expect(formatUnitQuantity(-150)).toBe("-1.5");
    expect(formatUnitAmount(250, "drinks")).toBe("2.5 drinks");
  });

  it("normalizes names and enforces the shared limit", () => {
    expect(normalizeUnitName("  Drinks  ")).toBe("Drinks");
    expect(normalizeUnitName("hot   drinks")).toBe("hot drinks");
    expect(unitNameError("   ")).toBe("Unit name is required");
    expect(unitNameError("x".repeat(41))).toContain("40");
    expect(unitNameError("drinks")).toBeNull();
  });
});

describe("unit balances", () => {
  it("reconciles like money when enabled", () => {
    const result = computeUnitBalances(ids, [expense(1, 300, [[1, 100], [2, 100], [3, 100]])], [], true);
    expect(result.nets).toEqual([
      { userId: 1, netCents: 200 },
      { userId: 2, netCents: -100 },
      { userId: 3, netCents: -100 },
    ]);
    expect(result.transfers).toEqual([
      { from: 2, to: 1, amountCents: 100 },
      { from: 3, to: 1, amountCents: 100 },
    ]);
    expect(result.obligations).toEqual([]);
  });

  it("keeps direct obligations in both directions when disabled", () => {
    const result = computeUnitBalances(ids, [
      expense(1, 300, [[1, 100], [2, 100], [3, 100]]),
      expense(2, 200, [[1, 100], [2, 100]]),
    ], [], false);
    expect(result.transfers).toEqual([]);
    expect(result.obligations).toEqual([
      { from: 1, to: 2, amountCents: 100 },
      { from: 2, to: 1, amountCents: 100 },
      { from: 3, to: 1, amountCents: 100 },
    ]);
  });

  it("reduces only the payer's direct obligation with a recorded repayment", () => {
    const result = computeUnitBalances(ids, [
      expense(1, 300, [[1, 100], [2, 100], [3, 100]]),
      expense(2, 200, [[1, 100], [2, 100]]),
    ], [{ payerId: 1, recipientId: 2, amountCents: 100 }], false);
    expect(directedObligation(result.obligations, 1, 2)).toBe(0);
    expect(directedObligation(result.obligations, 2, 1)).toBe(100);
  });

  it("shows a historic excess as the reverse obligation", () => {
    const result = computeUnitBalances(ids, [
      expense(1, 200, [[1, 100], [2, 100]]),
    ], [{ payerId: 2, recipientId: 1, amountCents: 200 }], false);
    expect(result.obligations).toEqual([{ from: 1, to: 2, amountCents: 100 }]);
  });

  it("clears a reversed excess with one repayment", () => {
    const result = computeUnitBalances(ids, [
      expense(1, 200, [[1, 100], [2, 100]]),
    ], [
      { payerId: 2, recipientId: 1, amountCents: 200 },
      { payerId: 1, recipientId: 2, amountCents: 100 },
    ], false);
    expect(result.obligations).toEqual([]);
    expect(result.nets).toEqual([
      { userId: 1, netCents: 0 },
      { userId: 2, netCents: 0 },
      { userId: 3, netCents: 0 },
    ]);
  });

  it("adds a repayment to the same direction instead of duplicating it", () => {
    const result = computeUnitBalances(ids, [
      expense(2, 200, [[1, 100], [2, 100]]),
    ], [{ payerId: 2, recipientId: 1, amountCents: 200 }], false);
    expect(result.obligations).toEqual([{ from: 1, to: 2, amountCents: 300 }]);
  });

  it("rejects an over-repayment only when reconciliation is off", () => {
    const obligations = [{ from: 2, to: 1, amountCents: 100 }];
    expect(validateUnitRepayment({ reconcile: true, obligations, payerId: 2, recipientId: 1, amountCents: 500 })).toBeNull();
    expect(validateUnitRepayment({ reconcile: false, obligations, payerId: 2, recipientId: 1, amountCents: 101 }))
      .toContain("more than the 1 still owed");
    expect(validateUnitRepayment({ reconcile: false, obligations, payerId: 2, recipientId: 1, amountCents: 100 }))
      .toBeNull();
  });

  it("nets repayments against the same unit when enabled", () => {
    const result = computeUnitBalances(ids, [
      expense(1, 300, [[1, 100], [2, 100], [3, 100]]),
    ], [{ payerId: 2, recipientId: 1, amountCents: 100 }], true);
    expect(result.nets).toEqual([
      { userId: 1, netCents: 100 },
      { userId: 2, netCents: 0 },
      { userId: 3, netCents: -100 },
    ]);
    expect(result.transfers).toEqual([{ from: 3, to: 1, amountCents: 100 }]);
  });
});
