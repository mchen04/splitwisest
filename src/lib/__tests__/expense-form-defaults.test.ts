import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("expense form defaults", () => {
  it("starts a new expense with one non-payer owing the full amount", () => {
    const form = source("src/components/expense-form.tsx");
    const splits = source("src/components/expense-splits.tsx");
    expect(form).toContain('useState<Method>("solo")');
    expect(form).toContain("member.id !== meId");
    expect(form).toContain('method === "solo" ? "equal" : method');
    expect(splits).toContain('solo: "One person"');
    expect(splits).toContain("Who owes the full amount?");
  });
});
