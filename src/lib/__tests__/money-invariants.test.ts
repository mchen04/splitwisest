import { describe, expect, it } from "vitest";
import { computeItemizedShares, computeShares, simplifyDebts } from "../money";

let seed = 7301;
const random = (limit: number) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % limit;
const sum = (values: Iterable<number>) => [...values].reduce((a, b) => a + b, 0);

function minimumCount(values: number[]): number {
  const next = values.findIndex((v) => v !== 0);
  if (next < 0) return 0;
  let best = Infinity;
  for (let i = next + 1; i < values.length; i++) {
    if (values[next] * values[i] >= 0) continue;
    const after = [...values];
    after[i] += after[next]; after[next] = 0;
    best = Math.min(best, 1 + minimumCount(after));
  }
  return best;
}

function clears(net: Map<number, number>, plan: ReturnType<typeof simplifyDebts>) {
  const remaining = new Map(net);
  for (const t of plan) {
    expect(Number.isSafeInteger(t.amountCents) && t.amountCents > 0).toBe(true);
    expect(t.from).not.toBe(t.to);
    remaining.set(t.from, remaining.get(t.from)! + t.amountCents);
    remaining.set(t.to, remaining.get(t.to)! - t.amountCents);
  }
  expect([...remaining.values()].every((n) => n === 0)).toBe(true);
}

describe("ledger invariants", () => {
  it("conserves every cent and currency unit across all split methods", () => {
    for (const step of [1, 100]) for (let count = 1; count <= 8; count++) for (let trial = 0; trial < 20; trial++) {
      const total = (random(1_000_000) + 1) * step;
      const ids = Array.from({ length: count }, (_, i) => i + 1);
      const exact = ids.map((userId, i) => ({ userId, value: i === 0 ? total : 0 }));
      const weights = ids.map((userId, i) => ({ userId, value: i + 1 }));
      const percentages = ids.map((userId, i) => ({ userId, value: i === 0 ? 100 : 0 }));
      for (const [method, inputs] of [["equal", exact], ["exact", exact], ["shares", weights], ["percentage", percentages]] as const) {
        const shares = computeShares(method, total, inputs, step);
        expect(sum(shares.values())).toBe(total);
        expect([...shares.values()].every((n) => Number.isSafeInteger(n) && n >= 0 && n % step === 0)).toBe(true);
      }
      const item = Math.floor(total / step / 3) * step;
      const shares = computeItemizedShares(total, [
        { amountCents: item, participantIds: ids },
        { amountCents: total - item, participantIds: ids.slice(0, 1) },
      ], {}, step);
      expect(sum(shares.values())).toBe(total);
      expect([...shares.values()].every((n) => n % step === 0)).toBe(true);
    }
  });

  it("matches an independent debt search for seeded small ledgers", () => {
    for (let count = 2; count <= 9; count++) for (let trial = 0; trial < 30; trial++) {
      const values = Array.from({ length: count - 1 }, () => random(21) - 10);
      values.push(-sum(values));
      const net = new Map(values.map((n, i) => [i + 1, n]));
      const plan = simplifyDebts(net);
      clears(net, plan);
      expect(plan.length).toBe(minimumCount(values));
    }
  });

  it("clears varied ledgers at the exact boundary and above the fallback boundary", () => {
    for (const count of [18, 19, 35]) {
      const values = Array.from({ length: count - 1 }, () => random(10000) - 5000);
      values.push(-sum(values));
      const net = new Map(values.map((n, i) => [i + 1, n]));
      const plan = simplifyDebts(net);
      clears(net, plan);
      expect(plan).toEqual(simplifyDebts(new Map([...net].reverse())));
    }
  });
});
