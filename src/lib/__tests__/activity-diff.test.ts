import { describe, expect, it } from "vitest";
import { Change, describeChange, diffExpense, ExpenseSnapshot, feedLine } from "../activity-diff";

const base: ExpenseSnapshot = {
  title: "Dinner",
  amountCents: 4200,
  currency: "USD",
  date: "2026-08-03",
  payerName: "Matthew",
  categoryName: "Food",
  notes: "",
  splitMethod: "equal",
  shares: [
    { userId: 1, name: "Matthew", shareCents: 2100, rawInput: null },
    { userId: 2, name: "Sarah", shareCents: 2100, rawInput: null },
  ],
};

const snap = (over: Partial<ExpenseSnapshot>): ExpenseSnapshot => ({ ...base, ...over });
const fields = (c: Change[]) => c.map((x) => x.field);
const text = (prev: ExpenseSnapshot, next: ExpenseSnapshot) =>
  diffExpense(prev, next).map(describeChange);

describe("diffExpense — one field at a time", () => {
  it("reports nothing when the edit changes nothing", () => {
    expect(diffExpense(base, snap({}))).toEqual([]);
  });

  it("detects the amount", () => {
    expect(text(base, snap({ amountCents: 3850 }))).toEqual([
      "changed the amount from $42.00 to $38.50",
    ]);
  });

  it("detects the currency without leaking derived conversion fields", () => {
    const changes = diffExpense(base, snap({ currency: "EUR" }));
    expect(fields(changes)).toEqual(["currency"]);
    expect(describeChange(changes[0])).toBe("changed the currency from USD to EUR");
  });

  it("detects the title", () => {
    expect(text(base, snap({ title: "Dinner + drinks" }))).toEqual([
      'renamed it from "Dinner" to "Dinner + drinks"',
    ]);
  });

  it("detects who paid", () => {
    expect(text(base, snap({ payerName: "Sarah" }))).toEqual([
      "changed who paid from Matthew to Sarah",
    ]);
  });

  it("detects the date", () => {
    expect(text(base, snap({ date: "2026-08-05" }))).toEqual([
      "moved the date from Aug 3 to Aug 5",
    ]);
  });

  it("detects the category, including setting and clearing it", () => {
    expect(text(base, snap({ categoryName: "Travel" }))).toEqual([
      "changed the category from Food to Travel",
    ]);
    expect(text(base, snap({ categoryName: null }))).toEqual(["cleared the category"]);
    expect(text(snap({ categoryName: null }), base)).toEqual(["set the category to Food"]);
  });

  it("detects notes being added, changed, and removed", () => {
    expect(text(base, snap({ notes: "split the taxi" }))).toEqual(["added a note"]);
    expect(text(snap({ notes: "a" }), snap({ notes: "b" }))).toEqual(["changed the note"]);
    expect(text(snap({ notes: "a" }), base)).toEqual(["removed the note"]);
  });

  it("detects the split method for every method the app supports", () => {
    const methods = ["solo", "equal", "exact", "percentage", "shares", "itemized"];
    for (const to of methods.filter((m) => m !== "equal")) {
      const changes = diffExpense(base, snap({ splitMethod: to }));
      expect(fields(changes)).toContain("splitMethod");
    }
    expect(text(base, snap({ splitMethod: "exact" }))).toEqual([
      "switched the split from equal to exact amounts",
    ]);
  });

  it("detects per-person values changing while membership holds", () => {
    const next = snap({
      splitMethod: "exact",
      shares: [
        { userId: 1, name: "Matthew", shareCents: 3000, rawInput: 30 },
        { userId: 2, name: "Sarah", shareCents: 1200, rawInput: 12 },
      ],
    });
    expect(fields(diffExpense(base, next))).toEqual(["splitMethod", "splitValues"]);
  });

  it("does not report per-person values when an equal split just follows the amount", () => {
    const prev = snap({
      shares: [
        { userId: 1, name: "Matthew", shareCents: 2100, rawInput: null },
        { userId: 2, name: "Sarah", shareCents: 2100, rawInput: null },
      ],
    });
    const next = snap({
      amountCents: 5000,
      shares: [
        { userId: 1, name: "Matthew", shareCents: 2500, rawInput: null },
        { userId: 2, name: "Sarah", shareCents: 2500, rawInput: null },
      ],
    });
    expect(fields(diffExpense(prev, next))).toEqual(["amount"]);
  });

  it("detects a per-person raw value change even when the cents match", () => {
    const prev = snap({
      splitMethod: "shares",
      shares: [
        { userId: 1, name: "Matthew", shareCents: 2100, rawInput: 1 },
        { userId: 2, name: "Sarah", shareCents: 2100, rawInput: 1 },
      ],
    });
    const next = snap({
      splitMethod: "shares",
      shares: [
        { userId: 1, name: "Matthew", shareCents: 2100, rawInput: 2 },
        { userId: 2, name: "Sarah", shareCents: 2100, rawInput: 2 },
      ],
    });
    expect(fields(diffExpense(prev, next))).toEqual(["splitValues"]);
  });

  it("detects people added to and removed from the split", () => {
    const added = snap({
      shares: [...base.shares, { userId: 3, name: "Priya", shareCents: 1400, rawInput: null }],
    });
    expect(text(base, added)).toEqual(["added Priya to the split"]);

    const removed = snap({ shares: [base.shares[0]] });
    expect(text(base, removed)).toEqual(["removed Sarah from the split"]);
  });
});

describe("diffExpense — combinations", () => {
  it("amount and payer together", () => {
    expect(fields(diffExpense(base, snap({ amountCents: 5000, payerName: "Sarah" })))).toEqual([
      "amount",
      "payer",
    ]);
  });

  it("split method switched and per-person values changed in one edit", () => {
    const next = snap({
      splitMethod: "percentage",
      shares: [
        { userId: 1, name: "Matthew", shareCents: 2520, rawInput: 60 },
        { userId: 2, name: "Sarah", shareCents: 1680, rawInput: 40 },
      ],
    });
    expect(fields(diffExpense(base, next))).toEqual(["splitMethod", "splitValues"]);
  });

  it("one person added and another removed in the same edit", () => {
    const next = snap({
      shares: [
        { userId: 1, name: "Matthew", shareCents: 2100, rawInput: null },
        { userId: 3, name: "Priya", shareCents: 2100, rawInput: null },
      ],
    });
    const changes = diffExpense(base, next);
    expect(fields(changes)).toEqual(["participantsRemoved", "participantsAdded"]);
    expect(changes.map(describeChange)).toEqual([
      "removed Sarah from the split",
      "added Priya to the split",
    ]);
  });

  it("names every person when several join at once", () => {
    const next = snap({
      shares: [
        ...base.shares,
        { userId: 3, name: "Priya", shareCents: 1000, rawInput: null },
        { userId: 4, name: "Sam", shareCents: 1000, rawInput: null },
      ],
    });
    expect(text(base, next)).toEqual(["added Priya and Sam to the split"]);
  });
});

describe("feedLine", () => {
  it("is null when nothing changed", () => {
    expect(feedLine([])).toBeNull();
  });

  it("reads as a full sentence for a single change", () => {
    expect(feedLine(diffExpense(base, snap({ amountCents: 3850 })))).toBe(
      "changed the amount from $42.00 to $38.50"
    );
  });

  it("leads with the highest ranked change and counts the rest", () => {
    const next = snap({ amountCents: 3850, payerName: "Sarah", title: "Lunch" });
    expect(feedLine(diffExpense(base, next))).toBe("changed the amount and 2 other things");
  });

  it("uses the singular for exactly one other thing", () => {
    const next = snap({ shares: [base.shares[0]], title: "Lunch" });
    expect(feedLine(diffExpense(base, next))).toBe(
      "removed Sarah from the split and 1 other thing"
    );
  });

  it("stays one short line when five or more fields move", () => {
    const next = snap({
      amountCents: 9900,
      payerName: "Sarah",
      title: "Lunch",
      date: "2026-09-01",
      categoryName: "Travel",
      notes: "new",
    });
    const changes = diffExpense(base, next);
    expect(changes.length).toBeGreaterThanOrEqual(5);
    const line = feedLine(changes)!;
    expect(line).toBe("changed the amount and 5 other things");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("…");
    expect(line.length).toBeLessThan(60);
  });

  it("ranks the split above the date, category, title, and notes", () => {
    const next = snap({ shares: [base.shares[0]], date: "2026-09-09", title: "Lunch" });
    expect(feedLine(diffExpense(base, next))).toMatch(/^removed Sarah from the split/);
  });

  it("ranks who paid above the split", () => {
    const next = snap({ payerName: "Sarah", shares: [base.shares[0]] });
    expect(feedLine(diffExpense(base, next))).toBe("changed who paid and 1 other thing");
  });
});
