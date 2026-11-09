import { describe, expect, it } from "vitest";
import { shareInputValue } from "../share-input";
import { splitShares } from "../money";

describe("Shares form weights", () => {
  it("charges two shares twice an untouched one-share box", () => {
    const participants = ["2", "", undefined].map((value, index) => ({
      userId: index + 1,
      value: shareInputValue(value),
    }));

    expect(participants.map(({ value }) => value)).toEqual([2, 1, 1]);
    expect([...splitShares(4000, participants).values()]).toEqual([2000, 1000, 1000]);
  });

  it("keeps an explicit zero and decimal weights", () => {
    const participants = ["0", "0.5", "1.5"].map((value, index) => ({
      userId: index + 1,
      value: shareInputValue(value),
    }));

    expect(participants.map(({ value }) => value)).toEqual([0, 0.5, 1.5]);
    expect([...splitShares(4000, participants).values()]).toEqual([0, 1000, 3000]);
  });
});
