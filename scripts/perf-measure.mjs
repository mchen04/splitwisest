#!/usr/bin/env node
// Repeatable performance measurement for the PWA goal. Runs Lighthouse (mobile
// emulation, N runs, median reported per metric) against a locally served
// production build, and records route payload sizes. Identical invocation for
// baseline and final numbers.
//
// Usage: node scripts/perf-measure.mjs <origin> [--runs 3] [--label baseline]
// Prints one JSON object to stdout; progress goes to stderr.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const origin = process.argv[2];
if (!origin) {
  console.error("usage: perf-measure.mjs <origin> [--runs N] [--label name]");
  process.exit(2);
}
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) {
  throw new Error("Use a local app started with the environment from pnpm db:local.");
}
const argv = process.argv.slice(3);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const RUNS = Number(flag("runs", "3"));
const LABEL = flag("label", "run");
const OUT_DIR = join(process.cwd(), ".pwa-harness", `perf-${LABEL}`);
mkdirSync(OUT_DIR, { recursive: true });

function chromePath() {
  const cache = join(process.env.HOME, "Library/Caches/ms-playwright");
  const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort();
  if (!dirs.length) throw new Error("no playwright chromium found for lighthouse");
  const candidates = [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const sub of candidates) {
    const candidate = join(cache, dirs[dirs.length - 1], sub);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("chromium binary not found in playwright cache");
}

const PAGES = ["/", "/groups", "/chat"];

// Measure "/" as the logged-in dashboard: authenticate with the harness's
// seeded demo user and pass the session cookie into every Lighthouse run.
async function sessionCookie() {
  const credsPath = join(process.cwd(), ".pwa-harness", "creds.json");
  try {
    const creds = JSON.parse(readFileSync(credsPath, "utf8"));
    const res = await fetch(origin + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ username: creds.username, password: creds.password }),
    });
    if (!res.ok) return null;
    const cookie = res.headers.getSetCookie?.()[0] ?? res.headers.get("set-cookie");
    return cookie ? cookie.split(";")[0] : null;
  } catch {
    return null;
  }
}
const cookie = await sessionCookie();
console.error(`[perf] session cookie: ${cookie ? "acquired" : "NONE (measuring logged-out)"}`);
const METRICS = [
  "first-contentful-paint",
  "largest-contentful-paint",
  "total-blocking-time",
  "cumulative-layout-shift",
  "speed-index",
  "interactive",
];

const results = { label: LABEL, origin, runs: RUNS, tool: "lighthouse 12.8.2 --preset=mobile (default moto-g4 profile, 4x cpu)", pages: {} };

for (const page of PAGES) {
  const perRun = [];
  for (let i = 0; i < RUNS; i++) {
    const out = join(OUT_DIR, `lh${page.replace(/\//g, "_")}-${i}.json`);
    console.error(`[perf] lighthouse ${page} run ${i + 1}/${RUNS}`);
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = spawnSync("npx", ["--yes", "lighthouse", origin + page,
      "--output=json", `--output-path=${out}`,
      "--only-categories=performance",
      // The cookie only makes sense on app pages: an authed /login instantly
      // client-redirects to "/", which Lighthouse reports as NO_FCP.
      ...(cookie ? [`--extra-headers=${JSON.stringify({ Cookie: cookie })}`] : []),
      "--form-factor=mobile", "--screenEmulation.mobile",
      "--quiet", "--chrome-flags=--headless=new --ignore-certificate-errors",
      ], { env: { ...process.env, CHROME_PATH: chromePath() }, encoding: "utf8" });
      if (res.status === 0) break;
      console.error(`[perf] retry ${attempt + 1} for ${page} (headless NO_FCP flake)`);
    }
    if (res.status !== 0) {
      console.error(`[perf] ${page} run ${i + 1} failed after retries; recording and continuing`);
      perRun.push(null);
      continue;
    }
    const report = JSON.parse(readFileSync(out, "utf8"));
    const run = { score: report.categories.performance.score };
    for (const m of METRICS) run[m] = report.audits[m].numericValue;
    perRun.push(run);
  }
  const ok = perRun.filter(Boolean);
  const median = {};
  for (const key of ["score", ...METRICS]) {
    const sorted = ok.map((r) => r[key]).sort((a, b) => a - b);
    median[key] = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  }
  results.pages[page] = { median, completedRuns: ok.length, runs: perRun };
}

// Bundle weight: every static file the live build ships, grouped.
function dirSize(dir, filter) {
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (!filter || filter(p)) total += st.size;
    }
  };
  walk(dir);
  return total;
}
const staticDir = join(process.cwd(), ".next", "static");
results.bundle = {
  jsBytes: dirSize(staticDir, (p) => p.endsWith(".js")),
  cssBytes: dirSize(staticDir, (p) => p.endsWith(".css")),
  totalStaticBytes: dirSize(staticDir),
};

writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
