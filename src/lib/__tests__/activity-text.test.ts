import { describe, expect, it } from "vitest";
import { activityActionText, activityAfterActor, activityChanges, activityData } from "../activity";

describe("activityActionText", () => {
  it("renders a recorded single change as a full sentence", () => {
    const data = {
      actionText: 'edited "Dinner" ($38.50)',
      changes: [
        { field: "amount", fromCents: 4200, toCents: 3850, fromCurrency: "USD", toCurrency: "USD" },
      ],
    };
    expect(activityActionText({ summary: "Matthew edited", actorName: "Matthew", data })).toBe(
      "changed the amount from $42.00 to $38.50"
    );
  });

  it("collapses several changes to one line with a count", () => {
    const data = {
      actionText: 'edited "Dinner" ($38.50)',
      changes: [
        { field: "amount", fromCents: 4200, toCents: 3850, fromCurrency: "USD", toCurrency: "USD" },
        { field: "payer", from: "Matthew", to: "Sarah" },
        { field: "title", from: "Dinner", to: "Lunch" },
      ],
    };
    expect(activityActionText({ summary: "Matthew edited", actorName: "Matthew", data })).toBe(
      "changed the amount and 2 other things"
    );
  });

  it("falls back to the stored wording for rows written before diffs existed", () => {
    const data = { actionText: 'edited "Dinner" ($42.00)' };
    expect(activityActionText({ summary: "Matthew edited", actorName: "Matthew", data })).toBe(
      'edited "Dinner" ($42.00)'
    );
  });

  it("falls back to the summary when there is no data at all", () => {
    expect(activityActionText({ summary: "Matthew added an expense", actorName: "Matthew" })).toBe(
      "added an expense"
    );
  });

  it("does not crash on malformed or empty change data", () => {
    for (const data of [{ changes: null }, { changes: [] }, { changes: "nope" }, { changes: [null, 3] }]) {
      expect(() =>
        activityActionText({ summary: "Matthew edited", actorName: "Matthew", data })
      ).not.toThrow();
    }
    expect(
      activityActionText({ summary: "Matthew edited", actorName: "Matthew", data: { changes: [] } })
    ).toBe("edited");
  });

  it("writes no change detail when an edit changed nothing", () => {
    const json = activityData({}, 'edited "Dinner" ($42.00)');
    expect(activityChanges(JSON.parse(json))).toEqual([]);
    expect(
      activityActionText({ summary: "Matthew edited", actorName: "Matthew", data: JSON.parse(json) })
    ).toBe('edited "Dinner" ($42.00)');
  });

  it("round-trips changes through the stored json", () => {
    const changes = [{ field: "participantsRemoved", names: ["Sarah"] }];
    const parsed = JSON.parse(activityData({ changes }, "edited"));
    expect(activityChanges(parsed)).toEqual(changes);
    expect(activityActionText({ summary: "x", actorName: "Matthew", data: parsed })).toBe(
      "removed Sarah from the split"
    );
  });
});

describe("activityAfterActor", () => {
  const paid = "Diego Romero paid Maya Chen $120.00 (recorded offline)";

  it("names the payer once when they recorded the payment", () => {
    const rest = activityAfterActor({ actorName: "Diego Romero", actionText: paid, type: "settlement.recorded" });
    expect(`Diego Romero${rest}`).toBe(paid);
  });

  it("keeps who recorded a payment when someone else paid", () => {
    const rest = activityAfterActor({ actorName: "Maya Chen", actionText: paid, type: "settlement.recorded" });
    expect(`Maya Chen${rest}`).toBe(`Maya Chen recorded that ${paid}`);
  });

  it("does not take a longer name for the actor's own", () => {
    const rest = activityAfterActor({ actorName: "Diego", actionText: paid, type: "settlement.recorded" });
    expect(`Diego${rest}`).toBe(`Diego recorded that ${paid}`);
  });

  it("leaves other activity and older payment rows unchanged", () => {
    expect(activityAfterActor({ actorName: "Maya", actionText: "added an expense", type: "expense.added" })).toBe(" added an expense");
    expect(activityAfterActor({ actorName: "Maya", actionText: "paid Sam $5.00", type: "settlement.recorded" })).toBe(" paid Sam $5.00");
    expect(activityAfterActor({ actorName: "Maya", actionText: "added an expense" })).toBe(" added an expense");
  });
});
