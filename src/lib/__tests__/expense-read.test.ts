import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("expense reads", () => {
  it.each([
    "src/app/api/expenses/[id]/route.ts",
    "src/app/api/expenses/[id]/comments/route.ts",
    "src/app/api/expenses/[id]/history/route.ts",
  ])("%s reads access and rows in one read-only snapshot", (path) => {
    const get = source(path).split("export const GET")[1].split("export const ")[0];

    expect(get).toContain("sql.transaction(");
    expect(get).toContain("EXPENSE_READ");
    expect(get.indexOf("assertExpenseAccess(")).toBeGreaterThan(get.indexOf("EXPENSE_READ"));
    expect(get.match(/await sql`/g)).toBeNull();
  });
});
