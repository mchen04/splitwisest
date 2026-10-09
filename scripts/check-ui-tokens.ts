import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface UiTokenViolation {
  file: string;
  line: number;
  rule: string;
  match: string;
}

// The shared primitives own the raw ramp (inputs need 16px on phones and 14px
// from sm up to stop iOS zooming). Everything else names a type role.
const PRIMITIVES = /(?:^|\/)components\/ui\.tsx$/;

const RULES: { name: string; pattern: RegExp; componentsOnly?: boolean; skip?: RegExp }[] = [
  {
    name: "arbitrary pixel class",
    pattern: /\b[a-z-]+-\[[^\]]*\d+(?:\.\d+)?px[^\]]*\]/g,
  },
  {
    name: "arbitrary text size",
    pattern: /\btext-\[(?:\d|\.\d)[^\]]*\]/g,
  },
  {
    name: "arbitrary radius",
    pattern: /\brounded(?:-[trbl]{1,2})?-\[(?:\d|\.\d)[^\]]*\]/g,
  },
  {
    name: "hard-coded component color",
    pattern: /#[0-9a-fA-F]{3,8}\b/g,
    componentsOnly: true,
  },
  {
    // 18px sits a 1.11 step under 20px, too close to read as its own level.
    // The ramp runs 12 / 14 / 16 / 20 / 24 / 32 / 40 and `--text-lg` is unset,
    // so this class would silently render at the browser default.
    name: "off-ramp text size (text-lg)",
    pattern: /\btext-lg\b/g,
    componentsOnly: true,
  },
  {
    // Screens use type roles (meta, body, row, section, title, amount,
    // amount-lg, hero) so the same job always gets the same size.
    name: "raw type size (use a type role)",
    pattern: /\btext-(?:xs|sm|base|xl|2xl|3xl|4xl)\b/g,
    componentsOnly: true,
    skip: PRIMITIVES,
  },
];

export function findUiTokenViolations(source: string, file = "component.tsx"): UiTokenViolation[] {
  const isComponent = file.endsWith(".tsx") || file.endsWith(".ts");
  const violations: UiTokenViolation[] = [];
  for (const rule of RULES) {
    if (rule.componentsOnly && !isComponent) continue;
    if (rule.skip?.test(file)) continue;
    for (const match of source.matchAll(rule.pattern)) {
      const index = match.index ?? 0;
      const lineStart = source.lastIndexOf("\n", index) + 1;
      const lineEnd = source.indexOf("\n", index);
      const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
      if (line.includes("ui-token-allow")) continue;
      violations.push({
        file,
        line: source.slice(0, index).split("\n").length,
        rule: rule.name,
        match: match[0],
      });
    }
  }
  if (isComponent) {
    // A grid with no base column template sizes its one implicit column to
    // content, so a long truncated name pushes the page sideways on a phone.
    for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const classes = match[1] ?? match[2] ?? "";
      if (!/(?:^|\s)grid(?:\s|$)/.test(classes) || /(?:^|\s)grid-cols-/.test(classes)) continue;
      const index = match.index ?? 0;
      const lineStart = source.lastIndexOf("\n", index) + 1;
      const lineEnd = source.indexOf("\n", index);
      if (source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).includes("ui-token-allow")) continue;
      violations.push({
        file,
        line: source.slice(0, index).split("\n").length,
        rule: "grid without a base column template",
        match: classes.slice(0, 60),
      });
    }
  }
  if (isComponent) {
    // Button radios must behave like native ones: one Tab stop and arrow keys
    // (radioGroupKeyDown on the group, radioTabIndex on each option).
    const required: Record<string, string> = { radiogroup: "radioGroupKeyDown", radio: "radioTabIndex" };
    for (const match of source.matchAll(/role="(radiogroup|radio)"/g)) {
      const index = match.index ?? 0;
      const tagStart = source.lastIndexOf("<", index);
      const rest = source.slice(index);
      const tagEnd = index + (rest.search(/[^=]>/) + 1 || rest.length);
      const tag = source.slice(tagStart, tagEnd);
      if (tag.includes(required[match[1]]) || tag.includes("ui-token-allow")) continue;
      violations.push({
        file,
        line: source.slice(0, index).split("\n").length,
        rule: `${match[1]} without ${required[match[1]]}`,
        match: match[0],
      });
    }
  }
  return violations;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === "__tests__") continue;
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:tsx|ts|css)$/.test(entry)) files.push(path);
  }
  return files;
}

export function scanUiTokens(root = join(process.cwd(), "src")): UiTokenViolation[] {
  return sourceFiles(root).flatMap((file) =>
    findUiTokenViolations(readFileSync(file, "utf8"), relative(process.cwd(), file))
  );
}

if (process.argv[1]?.endsWith("check-ui-tokens.ts")) {
  const violations = scanUiTokens();
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.file}:${violation.line} ${violation.rule}: ${violation.match}`);
    }
    process.exitCode = 1;
  } else {
    console.log("UI token check passed");
  }
}
