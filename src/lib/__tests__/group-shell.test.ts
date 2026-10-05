import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("static group page shell", () => {
  it("generates the shell per id and holds no request data", () => {
    const layout = source("src/app/groups/[id]/layout.tsx");

    expect(layout).toContain("export function generateStaticParams()");
    expect(layout).not.toMatch(/cookies\(|headers\(|searchParams/);
  });

  it("reads query params only inside the Suspense-wrapped GroupQuery", () => {
    const page = source("src/app/groups/[id]/page.tsx");
    const reader = page.slice(page.indexOf("function GroupQuery("), page.indexOf("export default function GroupPage("));

    expect(page.match(/useSearchParams\(\)/g)).toHaveLength(1);
    expect(reader).toContain("useSearchParams()");
    expect(page).toContain("<Suspense fallback={null}><GroupQuery onQuery={applyQuery} /></Suspense>");
  });
});
