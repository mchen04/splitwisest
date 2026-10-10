import { describe, expect, it } from "vitest";
import { defaultExpenseGroup } from "../last-group";

describe("Add expense default group", () => {
  it("opens the only group directly", () => {
    expect(defaultExpenseGroup([7], null)).toBe(7);
  });

  it("opens the remembered group when the user still belongs to it", () => {
    expect(defaultExpenseGroup([3, 7, 9], "7")).toBe(7);
  });

  it("asks when nothing is remembered or the remembered group is gone", () => {
    expect(defaultExpenseGroup([3, 7, 9], null)).toBeNull();
    expect(defaultExpenseGroup([3, 7, 9], "42")).toBeNull();
    expect(defaultExpenseGroup([3, 7, 9], "not-a-number")).toBeNull();
  });

  it("has nothing to open without groups", () => {
    expect(defaultExpenseGroup([], "7")).toBeNull();
  });
});
