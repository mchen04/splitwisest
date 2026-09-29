import { describe, expect, it } from "vitest";
import { computeGroupObligation, groupObligationDelta, GroupObligationBody, parseGroupMoney } from "../group-obligation-math";

const members = new Set([1, 2, 3, 4]);
const equal = (...ids: number[]) => ({ method: "equal" as const, participants: ids.map((userId) => ({ userId })) });
const exact = (...entries: [number, number][]) => ({ method: "exact" as const,
  participants: entries.map(([userId, value]) => ({ userId, value })) });

describe("group obligations", () => {
  it("reads exact money without accepting signs or extra precision", () => {
    expect(parseGroupMoney("1,234.56")).toBe(123456);
    expect(parseGroupMoney("12,34")).toBe(1234);
    expect(parseGroupMoney("0.00")).toBe(0);
    for (const bad of ["-5", "+5", "1.999", "abc5", "1..2", "1000000001", ""]) {
      expect(parseGroupMoney(bad)).toBeNull();
    }
  });
  it("nets people on both sides and leaves nonparticipants unchanged", () => {
    const input = GroupObligationBody.parse({ title: "Shared balance", amountCents: 12000,
      owes: equal(1, 2, 3), receives: exact([1, 8000], [2, 4000]) });
    const result = computeGroupObligation(input, members, "USD");
    expect([...result.net]).toEqual([[1, 4000], [2, 0], [3, -4000], [4, 0]]);
    expect([...result.owes.values()].reduce((a, b) => a + b, 0)).toBe(12000);
    expect([...result.receives.values()].reduce((a, b) => a + b, 0)).toBe(12000);
  });

  it("allocates odd cents deterministically for equal, percentages, and shares", () => {
    const input = GroupObligationBody.parse({ title: "Rounding", amountCents: 101,
      owes: equal(3, 1), receives: { method: "percentage", participants: [
        { userId: 2, value: 33.33 }, { userId: 3, value: 66.67 },
      ] } });
    const result = computeGroupObligation(input, members, "USD");
    expect([...result.owes]).toEqual([[1, 51], [3, 50]]);
    expect([...result.receives]).toEqual([[2, 34], [3, 67]]);
    const shares = computeGroupObligation(GroupObligationBody.parse({ ...input,
      receives: { method: "shares", participants: [
        { userId: 1, value: 1 }, { userId: 2, value: 1 }, { userId: 3, value: 1 },
      ] },
    }), members, "USD");
    expect([...shares.receives]).toEqual([[1, 34], [2, 34], [3, 33]]);
  });

  it("awards the exact largest remainders for high precision percentages", () => {
    const input = GroupObligationBody.parse({ title: "Exact remainder", amountCents: 99_999_999,
      owes: equal(4), receives: { method: "percentage", participants: [
        { userId: 1, value: 37.1454 }, { userId: 2, value: 25.709201 },
        { userId: 3, value: 37.145399 },
      ] },
    });
    expect([...computeGroupObligation(input, members, "USD").receives])
      .toEqual([[1, 37_145_399], [2, 25_709_201], [3, 37_145_399]]);
  });

  it("matches exact rational allocations across methods and boundary totals", () => {
    function expected(totalCents: number, step: number, weights: [number, string][]) {
      const totalUnits = BigInt(totalCents / step);
      const rows = weights.map(([id, weight]) => ({ id, weight: BigInt(weight.replace(".", "")) }));
      const denominator = rows.reduce((sum, row) => sum + row.weight, BigInt(0));
      const floors = rows.map((row) => ({ id: row.id,
        cents: Number(totalUnits * row.weight / denominator) * step,
        fraction: totalUnits * row.weight % denominator,
      }));
      const unassigned = totalCents - floors.reduce((sum, row) => sum + row.cents, 0);
      const winners = [...floors].sort((a, b) => a.fraction > b.fraction ? -1 :
        a.fraction < b.fraction ? 1 : a.id - b.id).slice(0, unassigned / step);
      return new Map(floors.map((row) => [row.id, row.cents + (winners.includes(row) ? step : 0)]));
    }
    const cases = [
      { method: "percentage" as const, weights: ["37.1454000", "25.7092010", "37.1453990"] },
      { method: "percentage" as const, weights: ["0.0000001", "99.9999999", "0.0000000"] },
      { method: "shares" as const, weights: ["0.0000001", "900719925.4740990", "1.0000000"] },
      { method: "shares" as const, weights: ["1.0000000", "1.0000000", "1.0000000"] },
    ];
    for (const [totalCents, currency, step] of [
      [1, "USD", 1], [2, "USD", 1], [101, "USD", 1],
      [99_999_999, "USD", 1], [100_000_000_000, "USD", 1],
      [100, "JPY", 100], [100_000_000_000, "JPY", 100],
    ] as const) {
      for (const { method, weights } of cases) {
        const participants = weights.map((weight, index) => ({ userId: index + 1, value: Number(weight) }));
        const input = GroupObligationBody.parse({ title: "Rational check", amountCents: totalCents,
          owes: { method, participants }, receives: { method, participants: [...participants].reverse() },
        });
        const result = computeGroupObligation(input, members, currency);
        const oracle = expected(totalCents, step, weights.map((weight, index) => [index + 1, weight]));
        expect(result.owes).toEqual(oracle);
        expect(result.receives).toEqual(oracle);
        expect([...result.net.values()]).toEqual([0, 0, 0, 0]);
      }
      const equalResult = computeGroupObligation(GroupObligationBody.parse({ title: "Equal",
        amountCents: totalCents, owes: equal(3, 2, 1), receives: equal(1, 2, 3),
      }), members, currency);
      expect(equalResult.owes).toEqual(expected(totalCents, step, [[1, "1"], [2, "1"], [3, "1"]]));
      const first = Math.floor(totalCents / 2 / step) * step;
      const exactResult = computeGroupObligation(GroupObligationBody.parse({ title: "Exact",
        amountCents: totalCents, owes: exact([1, first], [2, totalCents - first]),
        receives: exact([2, totalCents - first], [1, first]),
      }), members, currency);
      expect(exactResult.owes).toEqual(new Map([[1, first], [2, totalCents - first]]));
      expect(exactResult.receives).toEqual(exactResult.owes);
    }
  });

  it("keeps awarded cents on a title edit and orders new ties by user ID", () => {
    const old = { amountCents: 1,
      owes: { method: "equal" as const, participants: [
        { userId: 2, shareCents: 1, value: null }, { userId: 1, shareCents: 0, value: null },
      ] },
      receives: { method: "equal" as const, participants: [{ userId: 3, shareCents: 1, value: null }] },
    };
    const input = GroupObligationBody.parse({ title: "Renamed", amountCents: 1,
      owes: equal(1, 2), receives: equal(3) });
    expect([...computeGroupObligation(input, members, "USD", old).owes]).toEqual([[2, 1], [1, 0]]);
    expect([...computeGroupObligation(input, members, "USD").owes]).toEqual([[1, 1], [2, 0]]);
    expect([...computeGroupObligation({ ...input, owes: equal(2, 1) }, members, "USD").owes])
      .toEqual([[1, 1], [2, 0]]);
  });

  it("shows the true edit delta for old and new participants", () => {
    const old = { amountCents: 100,
      owes: { method: "equal" as const, participants: [{ userId: 1, shareCents: 100, value: null }] },
      receives: { method: "equal" as const, participants: [{ userId: 2, shareCents: 100, value: null }] },
    };
    const next = computeGroupObligation(GroupObligationBody.parse({ title: "Changed debtor", amountCents: 100,
      owes: equal(3), receives: equal(2) }), members, "USD", old);
    expect([...groupObligationDelta(next.net, old)]).toEqual([[1, 100], [2, 0], [3, -100], [4, 0]]);
  });

  it("supports exact owes with share based receives", () => {
    const input = GroupObligationBody.parse({ title: "Mixed", amountCents: 100,
      owes: exact([1, 60], [2, 40]),
      receives: { method: "shares", participants: [{ userId: 2, value: 1 }, { userId: 3, value: 3 }] },
    });
    expect([...computeGroupObligation(input, members, "USD").net]).toEqual([
      [1, -60], [2, -15], [3, 75], [4, 0],
    ]);
  });

  it("supports percentage owes with equal receives and cent rounding", () => {
    const input = GroupObligationBody.parse({ title: "Mixed", amountCents: 101,
      owes: { method: "percentage", participants: [{ userId: 1, value: 25 }, { userId: 2, value: 75 }] },
      receives: equal(1, 3),
    });
    expect([...computeGroupObligation(input, members, "USD").net]).toEqual([
      [1, 26], [2, -76], [3, 50], [4, 0],
    ]);
  });

  it("rejects percentage drift and excess weighted precision at the API boundary", () => {
    const base = { title: "Precise", amountCents: 100_000_000_000, owes: equal(1),
      receives: { method: "percentage", participants: [
        { userId: 2, value: 50 }, { userId: 3, value: 50.0009 },
      ] },
    };
    expect(() => computeGroupObligation(GroupObligationBody.parse(base), members, "USD")).toThrow(/100/);
    expect(() => computeGroupObligation(GroupObligationBody.parse({ ...base,
      owes: base.receives, receives: equal(1),
    }), members, "USD")).toThrow(/100/);
    expect(GroupObligationBody.safeParse({ ...base, receives: { method: "percentage", participants: [
      { userId: 2, value: 50.00000001 }, { userId: 3, value: 49.99999999 },
    ] } }).success).toBe(false);
    expect(GroupObligationBody.safeParse({ ...base, receives: { method: "shares", participants: [
      { userId: 2, value: 0.00000001 }, { userId: 3, value: 1 },
    ] } }).success).toBe(false);
    const valid = computeGroupObligation(GroupObligationBody.parse({ ...base, receives: {
      method: "percentage", participants: [{ userId: 2, value: 50.0000001 }, { userId: 3, value: 49.9999999 }],
    } }), members, "USD");
    expect([...valid.receives.values()].reduce((sum, cents) => sum + cents, 0)).toBe(base.amountCents);
    expect(GroupObligationBody.safeParse({ ...base, receives: { method: "shares", participants: [
      { userId: 2, value: 0.0000001 }, { userId: 3, value: 1 },
    ] } }).success).toBe(true);
  });

  it("rejects missing creditors, duplicates, outsiders, negative values, and mismatches", () => {
    const base = { title: "Bad", amountCents: 100, owes: equal(1), receives: equal(2) };
    expect(() => GroupObligationBody.parse({ ...base, receives: equal() })).toThrow();
    expect(() => computeGroupObligation(GroupObligationBody.parse({ ...base, owes: equal(1, 1) }), members, "USD")).toThrow(/Duplicate/);
    expect(() => computeGroupObligation(GroupObligationBody.parse({ ...base, receives: equal(5) }), members, "USD")).toThrow(/group members/);
    expect(() => GroupObligationBody.parse({ ...base, receives: exact([2, -100]) })).toThrow();
    expect(() => computeGroupObligation(GroupObligationBody.parse({ ...base, owes: exact([1, 99]) }), members, "USD")).toThrow(/add up/);
    expect(() => computeGroupObligation(GroupObligationBody.parse({ ...base,
      receives: { method: "percentage", participants: [{ userId: 2, value: 99 }] },
    }), members, "USD")).toThrow(/100/);
  });

  it("requires an explicit value for every selected non-equal participant", () => {
    const base = { title: "Weights", amountCents: 100, owes: equal(1), receives: equal(2) };
    for (const method of ["exact", "percentage", "shares"]) {
      expect(GroupObligationBody.safeParse({ ...base, receives: {
        method, participants: [{ userId: 2, value: method === "exact" ? 100 : method === "percentage" ? 100 : 1 },
          { userId: 3 }],
      } }).success).toBe(false);
    }
    for (const method of ["exact", "percentage", "shares"] as const) {
      const input = GroupObligationBody.parse({ ...base, receives: {
        method, participants: [
          { userId: 2, value: method === "shares" ? 1 : 100 }, { userId: 3, value: 0 },
        ],
      } });
      expect([...computeGroupObligation(input, members, "USD").receives]).toEqual([[2, 100], [3, 0]]);
    }
    expect(GroupObligationBody.safeParse(base).success).toBe(true);
  });

  it("keeps zero-decimal currencies in whole units", () => {
    const input = GroupObligationBody.parse({ title: "Yen", amountCents: 500,
      owes: equal(1, 2), receives: equal(3) });
    expect([...computeGroupObligation(input, members, "JPY").owes]).toEqual([[1, 300], [2, 200]]);
    expect(() => computeGroupObligation({ ...input, amountCents: 501 }, members, "JPY")).toThrow(/whole units/);
    expect(() => computeGroupObligation({ ...input, receives: exact([3, 250], [2, 250]) }, members, "JPY")).toThrow(/whole units/);
  });
});
