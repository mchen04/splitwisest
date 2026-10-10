import { afterEach, describe, expect, it } from "vitest";
import type { KeyboardEvent } from "react";
import { failureReason, radioGroupKeyDown, radioTabIndex } from "@/components/ui";

// Minimal stand-ins: the handler only reads the key, the group's radios, and focus.
function group(count: number, focused: number) {
  const log: string[] = [];
  const radios = Array.from({ length: count }, (_, i) => ({
    focus: () => { log.push(`focus ${i}`); },
    click: () => { log.push(`click ${i}`); },
  }));
  (globalThis as { document?: unknown }).document = { activeElement: radios[focused] };
  const press = (key: string) => {
    let prevented = false;
    radioGroupKeyDown({
      key, altKey: false, ctrlKey: false, metaKey: false,
      currentTarget: { querySelectorAll: () => radios },
      preventDefault: () => { prevented = true; },
    } as unknown as KeyboardEvent<HTMLElement>);
    return prevented;
  };
  return { log, press };
}

afterEach(() => { delete (globalThis as { document?: unknown }).document; });

describe("button radio groups", () => {
  it("moves to and selects the next option with the arrow keys, wrapping at the ends", () => {
    const { log, press } = group(3, 2);
    expect(press("ArrowRight")).toBe(true);
    expect(log).toEqual(["focus 0", "click 0"]);
  });

  it("moves back with ArrowLeft and ArrowUp", () => {
    const { log, press } = group(3, 0);
    press("ArrowUp");
    expect(log).toEqual(["focus 2", "click 2"]);
  });

  it("leaves other keys alone", () => {
    const { log, press } = group(3, 1);
    expect(press("Tab")).toBe(false);
    expect(press(" ")).toBe(false);
    expect(log).toEqual([]);
  });

  it("is one Tab stop: the checked option, or the first when none is checked", () => {
    expect([0, 1, 2].map((i) => radioTabIndex(i === 1, i, true))).toEqual([-1, 0, -1]);
    expect([0, 1, 2].map((i) => radioTabIndex(false, i, false))).toEqual([0, -1, -1]);
  });
});

describe("failureReason", () => {
  it("passes on what the server said, and points at the connection when nothing answered", () => {
    expect(failureReason("Group not found")).toBe("Group not found");
    expect(failureReason("Could not load data")).toBe("Check your connection and try again.");
    expect(failureReason(null)).toBe("Check your connection and try again.");
  });
});
