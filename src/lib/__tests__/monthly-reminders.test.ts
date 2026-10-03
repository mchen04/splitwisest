import { describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ sql: vi.fn() }));
import { monthlyReminderPeriod } from "../monthly-reminders";

describe("monthly reminder UTC window", () => {
  it.each([
    ["2026-10-31T23:59:59Z", null],
    ["2026-11-01T00:00:00Z", null],
    ["2026-11-01T16:59:59.999Z", null],
    ["2026-11-01T17:00:00Z", "2026-11"],
    ["2026-11-01T23:59:59.999Z", "2026-11"],
    ["2026-11-02T00:00:00Z", null],
    ["2026-12-01T09:00:00-08:00", "2026-12"],
    ["2027-01-01T17:00:00Z", "2027-01"],
    ["2028-02-01T17:00:00Z", "2028-02"],
    ["2028-02-29T17:00:00Z", null],
    ["2028-03-01T17:00:00Z", "2028-03"],
    ["invalid", null],
  ])("%s yields %s", (date, period) => {
    expect(monthlyReminderPeriod(new Date(date))).toBe(period);
  });
});
