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

  it("keeps zero-decimal currencies in whole units", () => {
    const input = GroupObligationBody.parse({ title: "Yen", amountCents: 500,
      owes: equal(1, 2), receives: equal(3) });
    expect([...computeGroupObligation(input, members, "JPY").owes]).toEqual([[1, 300], [2, 200]]);
    expect(() => computeGroupObligation({ ...input, amountCents: 501 }, members, "JPY")).toThrow(/whole units/);
    expect(() => computeGroupObligation({ ...input, receives: exact([3, 250], [2, 250]) }, members, "JPY")).toThrow(/whole units/);
  });
});
