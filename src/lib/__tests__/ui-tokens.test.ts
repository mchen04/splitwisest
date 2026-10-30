import { describe, expect, it } from "vitest";
import { findUiTokenViolations } from "../../../scripts/check-ui-tokens";

describe("UI token enforcement", () => {
  it("rejects one-off sizes and colors", () => {
    const source = '<div className="text-[13px] rounded-[10px] w-[37px] text-[#123456]" />';
    expect(findUiTokenViolations(source, "example.tsx").map((item) => item.rule)).toEqual([
      "arbitrary pixel class",
      "arbitrary pixel class",
      "arbitrary pixel class",
      "arbitrary text size",
      "arbitrary radius",
      "hard-coded component color",
    ]);
  });

  it("allows named tokens and structural values", () => {
    const source = '<div className="text-body rounded-lg w-[78%] text-[var(--group-ink)]" />';
    expect(findUiTokenViolations(source, "example.tsx")).toEqual([]);
  });

  it("requires type roles outside the shared primitives", () => {
    const source = '<p className="text-sm sm:text-xs text-2xl" />';
    expect(findUiTokenViolations(source, "src/app/page.tsx").map((item) => item.match))
      .toEqual(["text-sm", "text-xs", "text-2xl"]);
    expect(findUiTokenViolations(source, "src/components/ui.tsx")).toEqual([]);
    expect(findUiTokenViolations('<p className="text-meta sm:text-body text-amount" />', "src/app/page.tsx")).toEqual([]);
  });

  it("requires grids to declare a base column template", () => {
    expect(findUiTokenViolations('<ul className="grid gap-2 sm:grid-cols-2" />', "src/app/page.tsx").map((item) => item.rule))
      .toEqual(["grid without a base column template"]);
    expect(findUiTokenViolations('<ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" />', "src/app/page.tsx")).toEqual([]);
    expect(findUiTokenViolations('<ul className="hidden md:grid md:grid-cols-5" />', "src/app/page.tsx")).toEqual([]);
  });

  it("requires button radios to take arrow keys and one Tab stop", () => {
    const bare = '<div role="radiogroup" aria-label="Pick"><button type="button" role="radio" aria-checked={on} onClick={() => pick(1)}>One</button></div>';
    expect(findUiTokenViolations(bare, "src/app/page.tsx").map((item) => item.rule))
      .toEqual(["radiogroup without radioGroupKeyDown", "radio without radioTabIndex"]);
    const keyed = '<div role="radiogroup" aria-label="Pick" onKeyDown={radioGroupKeyDown}><button type="button" role="radio" aria-checked={on} tabIndex={radioTabIndex(on, 0, true)} onClick={() => pick(1)}>One</button></div>';
    expect(findUiTokenViolations(keyed, "src/app/page.tsx")).toEqual([]);
  });

  it("rejects an off-ramp text size", () => {
    expect(findUiTokenViolations('<h2 className="text-lg" />', "example.tsx").map((item) => item.rule))
      .toEqual(["off-ramp text size (text-lg)"]);
  });
});
