import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { amountInputToCents, splitPercentage, splitShares } from "../money";
import { ParticipantSplit } from "../../components/expense-splits";

vi.mock("../db", () => ({ sql: vi.fn(async () => [
  { currency: "USD", rate_per_usd: 1, fetched_at: new Date() },
  { currency: "JPY", rate_per_usd: 149.5, fetched_at: new Date() },
  { currency: "KRW", rate_per_usd: 1370, fetched_at: new Date() },
]) }));

import { convert } from "../fx";

describe("money audit regressions", () => {
  it("rounds decimal amount input at half cents without binary drift", () => {
    expect(amountInputToCents("1.005")).toBe(101);
    expect(amountInputToCents("10.075")).toBe(1008);
    expect(amountInputToCents("10,075")).toBe(1007500);
  });
  it("allocates high precision expense weights using exact largest remainders", () => {
    const inputs = [37.1454, 25.709201, 37.145399].map((value, i) => ({ userId: i + 1, value }));
    expect([...splitPercentage(99_999_999, inputs).values()]).toEqual([37_145_399, 25_709_201, 37_145_399]);
    expect([...splitShares(99_999_999, inputs).values()]).toEqual([37_145_399, 25_709_201, 37_145_399]);
  });

  it("rejects percentage totals that differ from 100", () => {
    expect(() => splitPercentage(100_000_000_000, [{ userId: 1, value: 50 }, { userId: 2, value: 50.0009 }])).toThrow(/100/);
  });

  it("handles large finite share weights without overflow", () => {
    expect([...splitShares(101, [{ userId: 1, value: 1e308 }, { userId: 2, value: 1e308 }]).values()]).toEqual([51, 50]);
  });

  it("keeps tiny positive conversions at one target unit", async () => {
    expect((await convert(100, "KRW", "USD")).cents).toBe(1);
  });

  it("rounds FX once in the target unit", async () => {
    expect((await convert(1, "USD", "JPY")).cents).toBe(100);
  });

  it("previews each participant's actual whole-yen equal share", () => {
    const html = renderToStaticMarkup(createElement(ParticipantSplit, {
      members: [{ id: 1, displayName: "Alice" }, { id: 2, displayName: "Bob" }],
      selected: new Set([1, 2]), method: "equal", values: {}, amountCents: 500,
      currency: "JPY", participantCount: 2, onToggle: () => {}, onValue: () => {},
    }));
    expect(html).toContain("¥2");
    expect(html.match(/¥3/g)).toHaveLength(1);
  });
});
