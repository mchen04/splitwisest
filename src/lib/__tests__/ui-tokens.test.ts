import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findUiTokenViolations, scanUiTokens } from "../../../scripts/check-ui-tokens";

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

  it("defines every type role on the 4px baseline", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    for (const role of ["meta", "body", "row", "section", "title", "amount", "amount-lg", "hero"]) {
      const size = css.match(new RegExp(`--text-${role}: ([\\d.]+)rem;`))?.[1];
      const line = css.match(new RegExp(`--text-${role}--line-height: ([\\d.]+)rem;`))?.[1];
      expect(size, role).toBeDefined();
      expect((Number(line) * 16) % 4, `${role} line height`).toBe(0);
    }
  });

  it("keeps the application source on the token system", () => {
    expect(scanUiTokens()).toEqual([]);
  });

  it("holds the ramp to one role per size", () => {
    // 12 / 14 / 16 / 20 / 24 / 32 / 40. 18 is unset because against 20 it is a
    // 1.11 step — close enough to read as an accident rather than a level.
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toContain("--text-lg: initial;");
    expect(css).toContain("--text-lg--line-height: initial;");
    expect(findUiTokenViolations('<h2 className="text-lg" />', "example.tsx").map((item) => item.rule))
      .toEqual(["off-ramp text size (text-lg)"]);
  });
});
