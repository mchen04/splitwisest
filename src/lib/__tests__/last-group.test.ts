import { describe, expect, it } from "vitest";
import { defaultExpenseGroup } from "../last-group";

describe("Add expense default group", () => {
  it("opens the only group directly", () => {
    expect(defaultExpenseGroup([7], null)).toBe(7);
  });

  it("opens the remembered group when the user still belongs to it", () => {
    expect(defaultExpenseGroup([3, 7, 9], "7")).toBe(7);
  });

  it("opens the most recently active group when nothing valid is remembered", () => {
    expect(defaultExpenseGroup([3, 7, 9], null)).toBe(3);
    expect(defaultExpenseGroup([3, 7, 9], "42")).toBe(3);
    expect(defaultExpenseGroup([3, 7, 9], "not-a-number")).toBe(3);
  });

  it("has nothing to open without groups", () => {
    expect(defaultExpenseGroup([], "7")).toBeNull();
  });
});
