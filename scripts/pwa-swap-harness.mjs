#!/usr/bin/env node
// Two-build local swap harness for the installed-PWA update/cache contract.
//
// Simulates a deploy with two local production builds that differ only in
// GITHUB_SHA, served in turn on ONE local origin, and drives the app as an
// INSTALLED app: Playwright WebKit, iPhone device profile, persistent storage,
// navigator.standalone=true, display-mode:standalone, launched at the
// manifest start_url. Prints one JSON line per scenario and a pass/fail
// summary; exits non-zero when a gate fails.
//
// Usage:
//   node scripts/pwa-swap-harness.mjs build            # produce builds A and B
//   node scripts/pwa-swap-harness.mjs suite [--port 3311] [--scenario name,...]
//   node scripts/pwa-swap-harness.mjs all
//
// Negative controls (each proves a check can go red):
//   node scripts/pwa-swap-harness.mjs suite --mutate <name>
//     no-swap        pretend a deploy happened without swapping the server
//     break-manifest check manifest agreement against a start_url changed alone
//     no-sw          serve 404 for /sw.js so no worker ever controls the app
//     flap-sw        alternate the worker's embedded build id per fetch,
//                    defeating the reload guard: stability checks must go red

import { webkit, devices } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import httpsMod from "node:https";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.DATABASE_URL ??= "postgres://postgres:postgres@127.0.0.1:5433/splitwisest";
process.env.NEON_LOCAL_PROXY ??= "http://127.0.0.1:4444/sql";
for (const key of ["DATABASE_URL", "NEON_LOCAL_PROXY"]) {
  if (!["localhost", "127.0.0.1", "[::1]", "db.localtest.me"].includes(new URL(process.env[key]).hostname)) {
    throw new Error(`${key} must use a local host. Run pnpm db:local and use its environment lines.`);
  }
}
const HDIR = join(ROOT, ".pwa-harness");
const NEXT_DIR = join(ROOT, ".next");
const SHAS = { A: "a".repeat(40), B: "b".repeat(40) };
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const PORT = Number(flag("port", "3311"));
// The app must run over HTTPS: the production session cookie is Secure, and
// WebKit (unlike Chromium) drops Secure cookies on plain http://localhost. A
// local TLS-terminating proxy on PORT fronts `next start` on INNER_PORT.
const INNER_PORT = PORT + 1;
const ORIGIN = `https://localhost:${PORT}`;
const INNER_ORIGIN = `http://localhost:${INNER_PORT}`;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // harness-side fetches to the self-signed proxy

const MUTATE = flag("mutate", null);
const ONLY = flag("scenario", null)?.split(",") ?? null;
const THROTTLE_WAIT_MS = Number(flag("throttle-wait", "61000"));
const results = [];
let server = null;
let liveSlot = null;

const log = (obj) => console.log(JSON.stringify(obj));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- builds ----------

function buildSlot(slot) {
  console.error(`[harness] building slot ${slot} (GITHUB_SHA=${SHAS[slot].slice(0, 8)}…)`);
  // A previous suite leaves .next as a symlink into a slot; building through
  // it would silently overwrite that slot and alias both builds to one dir.
  if (existsSync(NEXT_DIR) && lstatSync(NEXT_DIR).isSymbolicLink()) rmSync(NEXT_DIR);
  const res = spawnSync("pnpm", ["build"], {
    cwd: ROOT,
    env: { ...process.env, GITHUB_SHA: SHAS[slot] },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (res.status !== 0) throw new Error(`build ${slot} failed`);
  const dest = join(HDIR, `build-${slot}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(HDIR, { recursive: true });
  renameSync(NEXT_DIR, dest);
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else files.push("/_next/static/" + relative(join(dest, "static"), p));
    }
  };
  walk(join(dest, "static"));
  // next start serves public/ live from the repo, so the per-build worker
  // script must be snapshotted with its build and swapped alongside .next.
  const swPath = join(ROOT, "public/sw.js");
  if (existsSync(swPath)) writeFileSync(join(dest, "harness-sw.js"), readFileSync(swPath));
  const info = { slot, sha: SHAS[slot], buildId: readFileSync(join(dest, "BUILD_ID"), "utf8").trim(), staticFiles: files };
  writeFileSync(join(dest, "harness-info.json"), JSON.stringify(info));
  return info;
}

function loadInfo(slot) {
  return JSON.parse(readFileSync(join(HDIR, `build-${slot}`, "harness-info.json"), "utf8"));
}

// Chunk paths unique to each build: the DOM marker for which build a document
// belongs to, independent of what /api/version claims.
function distinguishers(a, b) {
  const setB = new Set(b.staticFiles);
  const setA = new Set(a.staticFiles);
  return {
    A: a.staticFiles.filter((f) => !setB.has(f) && f.endsWith(".js")),
    B: b.staticFiles.filter((f) => !setA.has(f) && f.endsWith(".js")),
  };
}

// ---------- server ----------

function linkBuild(slot) {
  if (existsSync(NEXT_DIR)) {
    const st = lstatSync(NEXT_DIR);
    if (st.isSymbolicLink()) rmSync(NEXT_DIR);
    else renameSync(NEXT_DIR, join(HDIR, `next-original-${Date.now()}`));
  }
  symlinkSync(join(HDIR, `build-${slot}`), NEXT_DIR);
  const snap = join(HDIR, `build-${slot}`, "harness-sw.js");
  if (existsSync(snap)) writeFileSync(join(ROOT, "public/sw.js"), readFileSync(snap));
}

async function startServer(slot) {
  linkBuild(slot);
  const proc = spawn(join(ROOT, "node_modules/.bin/next"), ["start", "-p", String(INNER_PORT)], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.env.HARNESS_VERBOSE && console.error(String(d)));
  const info = loadInfo(slot);
  let lastSeen = null;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    try {
      const v = await fetch(`${INNER_ORIGIN}/api/version`).then((r) => r.json());
      lastSeen = v.version;
      // A just-killed server can still answer a poll or two; keep polling
      // until the NEW build responds rather than failing on the first echo.
      if (v.version === info.buildId) {
        server = proc;
        liveSlot = slot;
        console.error(`[harness] server up: slot ${slot} build ${info.buildId.slice(0, 8)} on :${PORT}`);
        return;
      }
    } catch {}
  }
  throw new Error(`server did not come up as ${info.buildId} (last saw ${lastSeen})`);
}

async function stopServer() {
  if (!server) return;
  server.kill("SIGTERM");
  await new Promise((r) => {
    server.on("exit", r);
    setTimeout(r, 3000);
  });
  server = null;
}

async function swapTo(slot) {
  const t0 = Date.now();
  await stopServer();
  await startServer(slot);
  return Date.now() - t0;
}

// ---------- TLS proxy ----------

let proxy = null;

function ensureCert() {
  const dir = join(HDIR, "cert");
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(dir, { recursive: true });
    const res = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert,
      "-days", "30", "-nodes", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
    if (res.status !== 0) throw new Error("openssl cert generation failed");
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

let flapCounter = 0;

// Network-shaping knobs a scenario can flip at runtime.
const shape = { delayMs: 0, dropEveryNth: 0, dropCounter: 0 };

async function startProxy() {
  if (proxy) return;
  proxy = httpsMod.createServer(ensureCert(), (req, res) => {
    if (shape.dropEveryNth > 0 && ++shape.dropCounter % shape.dropEveryNth === 0) {
      res.destroy();
      return;
    }
    if (shape.delayMs > 0) {
      setTimeout(() => forward(req, res), shape.delayMs);
      return;
    }
    forward(req, res);
  });
  await new Promise((r) => proxy.listen(PORT, r));
  console.error(`[harness] tls proxy: ${ORIGIN} -> ${INNER_ORIGIN}`);
}

function forward(req, res) {
    // Negative controls are injected here, at the origin the app really talks
    // to, because worker-script fetches bypass in-page request interception.
    if (MUTATE === "flap-version-no-sw" && req.url === "/sw.js") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("sw withheld");
      return;
    }
    if (MUTATE === "flap-version-no-sw" && req.url === "/api/version") {
      // Deterministic reload loop through the no-worker poll path: every check
      // sees a "new" version, so the at-most-one-reload stability check must
      // go red.
      const body = JSON.stringify({ version: `flap${flapCounter++ % 2}` });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if (MUTATE === "flap-sw" && req.url === "/api/version") {
      // Pair the flapping worker with a flapping version endpoint, or the
      // policy's page-already-current guard would (correctly) defuse the loop.
      const body = JSON.stringify({ version: `flap${flapCounter % 2}` });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if ((MUTATE === "break-precache" || MUTATE === "swallow-precache") && req.url === "/icon-192.png") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("icon withheld: precache must fail");
      return;
    }
    if (MUTATE === "no-sw" && req.url === "/sw.js") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("sw withheld by --mutate no-sw");
      return;
    }
    const fwdHeaders = { ...req.headers, "x-forwarded-proto": "https" };
    // Body-rewriting mutations must see plaintext, not a gzip stream.
    if ((MUTATE === "flap-sw" || MUTATE === "swallow-precache") && req.url === "/sw.js") {
      delete fwdHeaders["accept-encoding"];
    }
    const fwd = http.request(
      { host: "localhost", port: INNER_PORT, path: req.url, method: req.method,
        headers: fwdHeaders },
      (up) => {
        if (MUTATE === "swallow-precache" && req.url === "/sw.js") {
          const chunks = [];
          up.on("data", (c) => chunks.push(c));
          up.on("end", () => {
            // The broken variant a strict install-gate must catch: a worker
            // that swallows its own precache failure and activates anyway.
            const body = Buffer.concat(chunks).toString("utf8")
              .replace("event.waitUntil(installWorker())", "event.waitUntil(installWorker().catch(() => self.skipWaiting()))");
            const headers = { ...up.headers, "content-length": Buffer.byteLength(body) };
            delete headers["content-encoding"];
            res.writeHead(up.statusCode, headers);
            res.end(body);
          });
          return;
        }
        if (MUTATE === "flap-sw" && req.url === "/sw.js") {
          const chunks = [];
          up.on("data", (c) => chunks.push(c));
          up.on("end", () => {
            // Alternate the embedded build id so every update check installs a
            // "new" worker: the at-most-one-reload check must go red.
            const body = Buffer.concat(chunks).toString("utf8")
              .replace(/BUILD_ID = "[^"]+"/, `BUILD_ID = "flap${flapCounter++ % 2}"`);
            const headers = { ...up.headers, "content-length": Buffer.byteLength(body) };
            delete headers["content-encoding"];
            res.writeHead(up.statusCode, headers);
            res.end(body);
          });
          return;
        }
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      }
    );
    fwd.on("error", () => res.destroy());
    req.pipe(fwd);
}

async function stopProxy() {
  if (!proxy) return;
  proxy.closeAllConnections?.();
  await new Promise((r) => proxy.close(r));
  proxy = null;
}

// ---------- browser ----------

const PROFILE = flag("profile", join(HDIR, "profile"));

async function launchApp({ offline = false, fresh = false } = {}) {
  if (fresh) rmSync(PROFILE, { recursive: true, force: true });
  const device = devices["iPhone 16 Pro"] ?? devices["iPhone 15 Pro"];
  const ctx = await webkit.launchPersistentContext(PROFILE, { ...device, offline, ignoreHTTPSErrors: true });
  await ctx.addInitScript(`(() => {
    if (!location.protocol.startsWith("http")) return;
    Object.defineProperty(navigator, "standalone", { get: () => true, configurable: true });
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (q) => q.includes("display-mode")
      ? { matches: q.includes("standalone"), media: q, onchange: null,
          addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
          dispatchEvent() { return false } }
      : mm(q);
    try {
      const k = "__harness_loads";
      const arr = JSON.parse(localStorage.getItem(k) || "[]");
      const entry = { t: Date.now(), url: location.pathname + location.search, type: null };
      arr.push(entry);
      localStorage.setItem(k, JSON.stringify(arr));
      window.addEventListener("load", () => {
        try {
          const nav = performance.getEntriesByType("navigation")[0];
          entry.type = nav ? nav.type : "unknown";
          const cur = JSON.parse(localStorage.getItem(k) || "[]");
          cur[cur.length - 1] = entry;
          localStorage.setItem(k, JSON.stringify(cur));
        } catch {}
      });
    } catch {}
  })()`);
  const page = ctx.pages()[0] ?? await ctx.newPage();
  if (process.env.HARNESS_CONSOLE) {
    page.on("console", (m) => console.error(`[page ${Date.now() % 100000}] ${m.type()}: ${m.text().slice(0, 300)}`));
    page.on("request", (r) => {
      const u = r.url();
      if (u.includes("/sw.js") || r.isNavigationRequest() || u.includes("_rsc")) {
        console.error(`[net ${Date.now() % 100000}] ${r.method()} ${u.slice(0, 140)}`);
      }
    });
    page.on("response", (r) => {
      const u = r.url();
      if (u.includes("/sw.js") || u.includes("_rsc")) {
        console.error(`[net ${Date.now() % 100000}] ${r.status()} ${u.slice(0, 140)}`);
      }
    });
  }
  return { ctx, page };
}

const safeEval = async (page, fn, arg, tries = 15) => {
  for (let i = 0; i < tries; i++) {
    try { return await page.evaluate(fn, arg); } catch { await sleep(400); }
  }
  throw new Error("evaluate kept failing (page never settled)");
};

const loadLog = (page) => safeEval(page, () => JSON.parse(localStorage.getItem("__harness_loads") || "[]"));
// The log is append-only; scenarios slice it by time so a racing reload can
// never erase its own evidence.
const loadsSince = async (page, t0) => (await loadLog(page)).filter((l) => l.t >= t0 - 250);

let BUILD_IDS = null; // { A: buildId, B: buildId }, set by suite()

async function domBuild(page, dist) {
  return safeEval(page, ({ A, B, ids }) => {
    // The meta marker only changes on a real document load. Script-set
    // fingerprints alone mislead: a soft navigation injects the NEW build's
    // chunks into the OLD document, which is "mixed", not a landing.
    const meta = document.querySelector('meta[name="build-id"]')?.getAttribute("content");
    if (meta && ids) {
      if (meta === ids.A) return "A";
      if (meta === ids.B) return "B";
    }
    const srcs = [...document.scripts].map((s) => s.src).filter(Boolean);
    const hit = (list) => list.some((c) => srcs.some((s) => s.includes(c)));
    const a = hit(A), b = hit(B);
    return a && b ? "mixed" : a ? "A" : b ? "B" : "unknown";
  }, { ...dist, ids: BUILD_IDS });
}

async function standaloneProbe(page) {
  return safeEval(page, () => ({
    standalone: navigator.standalone === true,
    displayModeStandalone: window.matchMedia("(display-mode: standalone)").matches,
    url: location.href,
    controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
  }));
}

async function cacheDump(page, dist, infos) {
  return safeEval(page, async ({ dist, ids }) => {
    const out = {};
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      const entries = [];
      for (const req of await cache.keys()) {
        const url = new URL(req.url);
        const entry = { url: url.pathname + url.search };
        if (/pages/.test(name) || url.pathname === "/" || !url.pathname.startsWith("/_next/")) {
          try {
            const res = await cache.match(req);
            const text = await res.clone().text();
            entry.docBuild = dist.A.some((c) => text.includes(c)) ? "A"
              : dist.B.some((c) => text.includes(c)) ? "B" : null;
            if (url.pathname.startsWith("/__splitwisest")) {
              entry.value = text.slice(0, 64);
              entry.docBuild = text === ids.A ? "A" : text === ids.B ? "B" : entry.docBuild;
            }
          } catch { entry.docBuild = "unreadable"; }
        }
        entries.push(entry);
      }
      out[name] = entries;
    }
    return out;
  }, { dist, ids: { A: infos.A.buildId, B: infos.B.buildId } });
}

function staleCount(dump, oldSlot, newInfo) {
  const newStatics = new Set(newInfo.staticFiles);
  const stale = [];
  for (const [cache, entries] of Object.entries(dump)) {
    for (const e of entries) {
      const path = e.url.split("?")[0];
      if (path.startsWith("/_next/static/") && !newStatics.has(path)) stale.push({ cache, ...e, reason: "chunk not in live build" });
      else if (e.docBuild === oldSlot) stale.push({ cache, ...e, reason: `content from build ${oldSlot}` });
    }
  }
  return stale;
}

// Wait until the DOM shows the target build and no further load happens for a
// settle window. Returns elapsed ms from t0 plus the load log.
async function settleOn(page, dist, target, t0, timeoutMs = 90000) {
  let landedAt = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const b = await domBuild(page, dist).catch(() => "transition");
    if (b === target) {
      landedAt ??= Date.now();
      const loads = await loadsSince(page, t0);
      const lastLoad = loads.length ? loads[loads.length - 1].t : 0;
      if (Date.now() - Math.max(landedAt, lastLoad) > 1500) {
        return { landed: true, ms: landedAt - t0, loads };
      }
    } else if (b !== "transition") landedAt = null;
    await sleep(150);
  }
  return { landed: false, ms: null, loads: await loadsSince(page, t0).catch(() => []) };
}

const reloadsIn = (loads) => loads.filter((l) => l.type === "reload").length;

// ---------- scenario bookkeeping ----------

function record(name, pass, detail) {
  const row = { scenario: name, pass, ...detail };
  results.push(row);
  log(row);
}

const wants = (name) => !ONLY || ONLY.includes(name);

// ---------- checks that need no browser ----------

function manifestAgreement() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "public/manifest.json"), "utf8"));
  if (MUTATE === "break-manifest") manifest.start_url = "/dashboard";
  const swSource = existsSync(join(ROOT, "public/sw.js"))
    ? readFileSync(join(ROOT, "public/sw.js"), "utf8")
    : readFileSync(join(ROOT, "src/sw/sw.template.js"), "utf8");
  const precachesStart = new RegExp(`(PRECACHE|PAGE_PRECACHE)[^;]*"${manifest.start_url.replace("/", "\\/")}"`).test(swSource)
    || swSource.includes(`cache.add("${manifest.start_url}")`)
    || swSource.includes(`"${manifest.start_url}"`);
  const agree = manifest.start_url === "/" && manifest.scope === "/" && manifest.id === "/"
    && manifest.display === "standalone" && precachesStart;
  return { manifest: { start_url: manifest.start_url, scope: manifest.scope, id: manifest.id, display: manifest.display }, workerPrecachesStartUrl: precachesStart, agree };
}

// ---------- suite ----------

async function seedCreds() {
  const credsPath = join(HDIR, "creds.json");
  if (existsSync(credsPath)) return JSON.parse(readFileSync(credsPath, "utf8"));
  console.error("[harness] seeding demo data…");
  const res = spawnSync("pnpm", ["tsx", "scripts/seed-ux-demo.ts", `h${String(Date.now()).slice(-6)}`], {
    cwd: ROOT,
    env: { ...process.env, SPLITWISEST_BASE_URL: INNER_ORIGIN },
    encoding: "utf8",
  });
  const start = res.stdout.indexOf("{");
  const end = res.stdout.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`seed failed: ${res.stdout}\n${res.stderr}`);
  const creds = JSON.parse(res.stdout.slice(start, end + 1)).login;
  writeFileSync(credsPath, JSON.stringify(creds));
  return creds;
}

async function login(page, creds) {
  await page.goto(`${ORIGIN}/login`, { waitUntil: "load" });
  await page.getByLabel("Username").fill(creds.username);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: /log in|sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
}

async function suite() {
  const infos = { A: loadInfo("A"), B: loadInfo("B") };
  const dist = distinguishers(infos.A, infos.B);
  BUILD_IDS = { A: infos.A.buildId, B: infos.B.buildId };
  if (!dist.A.length || !dist.B.length) throw new Error("builds are not distinguishable by chunk set");
  console.error(`[harness] builds A=${infos.A.buildId.slice(0, 8)} B=${infos.B.buildId.slice(0, 8)}; distinguishing chunks A:${dist.A.length} B:${dist.B.length}`);

  if (wants("manifest-agreement")) {
    const m = manifestAgreement();
    record("manifest-agreement", m.agree, m);
  }

  await startProxy();
  await startServer("A");
  const creds = await seedCreds();

  let app = null;
  const relaunch = async (opts) => {
    if (app) await app.ctx.close();
    app = await launchApp(opts);
    return app;
  };

  // S1: first install — launch at start_url, log in, worker installs, no reload.
  if (wants("install-fresh")) {
    const { page } = await relaunch({ fresh: true });
    const t0 = Date.now();
    await page.goto(ORIGIN + "/", { waitUntil: "load" });
    await sleep(2000);
    await login(page, creds);
    await page.goto(ORIGIN + "/", { waitUntil: "load" });
    await page.evaluate(() =>
      Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(r, 8000))])
    ).catch(() => {});
    await sleep(3000);
    const probe = await standaloneProbe(page);
    const loads = await loadsSince(page, t0);
    const dump = await cacheDump(page, dist, infos);
    record("install-fresh", probe.controller && reloadsIn(loads) === 0, {
      probe, reloads: reloadsIn(loads), loads, ms: Date.now() - t0,
      caches: Object.fromEntries(Object.entries(dump).map(([k, v]) => [k, v.length])),
    });
  }

  // S2: cold start, same build — instant, zero reloads.
  if (wants("cold-same-build")) {
    await app.ctx.close();
    app = await launchApp();
    const { page } = app;
    const t0 = Date.now();
    await page.goto(ORIGIN + "/", { waitUntil: "load" });
    const settled = await settleOn(page, dist, liveSlot, t0, 20000);
    const probe = await standaloneProbe(page);
    record("cold-same-build", settled.landed && reloadsIn(settled.loads) === 0, {
      liveBuild: liveSlot, probe, ms: settled.ms, reloads: reloadsIn(settled.loads), loads: settled.loads,
    });
  }

  // S3: cold start across a swap — land on the new build, ≤1 reload, 0 stale.
  if (wants("cold-swap")) {
    await app.ctx.close();
    const target = liveSlot === "A" ? "B" : "A";
    const old = liveSlot;
    // Under --mutate no-swap the server stays on the old build while the check
    // still expects the new one: the landing assertion must go red.
    if (MUTATE !== "no-swap") await swapTo(target);
    const expected = target;
    app = await launchApp();
    const { page } = app;
    const t0 = Date.now();
    await page.goto(ORIGIN + "/", { waitUntil: "load" });
    const settled = await settleOn(page, dist, expected, t0, 90000);
    await sleep(2500); // let the worker finish its post-landing stale sweep
    const probe = await standaloneProbe(page);
    const version = await fetch(`${ORIGIN}/api/version`).then((r) => r.json()).catch(() => null);
    const dump = await cacheDump(page, dist, infos);
    const stale = staleCount(dump, old, loadInfo(liveSlot));
    record("cold-swap", settled.landed && reloadsIn(settled.loads) <= 1 && stale.length === 0, {
      from: old, to: expected, probe, apiVersion: version?.version?.slice(0, 8),
      ms: settled.ms, reloads: reloadsIn(settled.loads), loads: settled.loads,
      staleEntries: stale.length, stale, caches: dump,
    });
  }

  // S4: three foreground cycles after landing — zero further reloads.
  if (wants("foreground-stability")) {
    const { page } = app;
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
      await sleep(THROTTLE_WAIT_MS);
      await safeEval(page, () => {
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        window.dispatchEvent(new Event("online"));
      });
      await sleep(4000);
    }
    const loads = await loadsSince(page, t0);
    record("foreground-stability", loads.length === 0, {
      cycles: 3, throttleWaitMs: THROTTLE_WAIT_MS, newLoads: loads.length, loads,
    });
  }

  // S5: in-session navigation across a swap.
  if (wants("insession-nav-swap")) {
    const { page } = app;
    const old = liveSlot;
    const target = old === "A" ? "B" : "A";
    const pageBuildBefore = await domBuild(page, dist);
    if (MUTATE !== "no-swap") await swapTo(target);
    const t0 = Date.now();
    // The same link exists in the hidden desktop sidebar and the visible
    // mobile nav; clicking the hidden copy waits 30 s for visibility. Target
    // only a visible one, with a JS-click fallback.
    await page.locator('a[href="/balances"]:visible, a[href="/groups"]:visible').first().click({ timeout: 3000 }).catch(async () => {
      await safeEval(page, () => { const a = document.querySelector('nav a[href="/groups"], nav a:not([aria-current])'); if (a) a.click(); });
    });
    const settled = await settleOn(page, dist, target, t0, 75000);
    const probe = await standaloneProbe(page);
    record("insession-nav-swap", pageBuildBefore === old && settled.landed && reloadsIn(settled.loads) <= 1, {
      from: old, to: target, pageBuildBefore, probe, ms: settled.ms, landed: settled.landed,
      reloads: reloadsIn(settled.loads), loads: settled.loads,
    });
  }

  // S6: foreground-resume across a swap, no navigation.
  if (wants("resume-swap")) {
    if (!app) throw new Error("resume-swap requires an earlier launch scenario, such as install-fresh");
    const { page } = app;
    const old = liveSlot;
    const target = old === "A" ? "B" : "A";
    const pageBuildBefore = await domBuild(page, dist);
    const hiddenAt = Date.now();
    const hiddenState = await safeEval(page, () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      return { visibilityState: document.visibilityState, hidden: document.hidden };
    });
    if (MUTATE !== "no-swap") await swapTo(target);
    await sleep(THROTTLE_WAIT_MS);
    const pageBuildWhileHidden = await domBuild(page, dist);
    const loadsWhileHidden = await loadsSince(page, hiddenAt);
    const stateBeforeResume = await safeEval(page, () => ({
      visibilityState: document.visibilityState,
      hidden: document.hidden,
    }));
    const t0 = Date.now();
    const visibleState = await safeEval(page, () => {
      delete document.visibilityState;
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      window.dispatchEvent(new Event("online"));
      return { visibilityState: document.visibilityState, hidden: document.hidden };
    });
    const settled = await settleOn(page, dist, target, t0, 90000);
    await sleep(2500); // let the worker finish its post-landing stale sweep
    const probe = await standaloneProbe(page);
    const dump = await cacheDump(page, dist, infos);
    const stale = staleCount(dump, old, loadInfo(liveSlot));
    record("resume-swap",
      pageBuildBefore === old
        && hiddenState.visibilityState === "hidden" && hiddenState.hidden === true
        && pageBuildWhileHidden === old && loadsWhileHidden.length === 0
        && stateBeforeResume.visibilityState === "hidden" && stateBeforeResume.hidden === true
        && visibleState.visibilityState === "visible" && visibleState.hidden === false
        && settled.landed && reloadsIn(settled.loads) === 1 && stale.length === 0, {
      from: old, to: target, pageBuildBefore, hiddenState, pageBuildWhileHidden,
      loadsWhileHidden: loadsWhileHidden.length, stateBeforeResume, visibleState, probe, ms: settled.ms,
      reloads: reloadsIn(settled.loads), loads: settled.loads, staleEntries: stale.length, stale,
    });
  }

  // S7: offline cold start — usable app shell on the last-good build, proven
  // to come from the worker's page cache: a marker is stamped into the cached
  // "/" entry first, so a document served by the HTTP disk cache (which has no
  // marker) cannot fake a pass. The no-sw mutation showed exactly that fake.
  if (wants("offline-cold")) {
    const { page: markPage } = app;
    const marked = await safeEval(markPage, async () => {
      for (const name of await caches.keys()) {
        if (!name.includes("pages")) continue;
        const cache = await caches.open(name);
        for (const req of await cache.keys()) {
          if (new URL(req.url).pathname !== "/") continue;
          const res = await cache.match(req);
          const html = (await res.clone().text())
            .replace("<head>", '<head><meta name="offline-source" content="sw-page-cache">');
          await cache.put(req, new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
          return true;
        }
      }
      return false;
    }).catch(() => false);
    await app.ctx.close();
    const lastGood = liveSlot;
    await stopServer();
    app = await launchApp();
    const { page } = app;
    const t0 = Date.now();
    await page.goto(ORIGIN + "/", { waitUntil: "load", timeout: 45000 }).catch(() => {});
    await sleep(2500);
    const state = await safeEval(page, () => ({
      title: document.title,
      isOfflinePage: document.title.startsWith("Offline"),
      hasAppRoot: !!document.querySelector(".app-frame, main, nav"),
      servedFromSwPageCache: document.querySelector('meta[name="offline-source"]')?.getAttribute("content") === "sw-page-cache",
      controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      bodyChars: document.body ? document.body.innerText.length : 0,
      url: location.href,
    })).catch((e) => ({ error: String(e) }));
    const b = await domBuild(page, dist).catch(() => "unknown");
    record("offline-cold",
      marked === true && !state.isOfflinePage && state.hasAppRoot === true
        && state.servedFromSwPageCache === true && state.controller === true && b === lastGood,
      { lastGood, markedCacheEntry: marked, domBuild: b, ms: Date.now() - t0, state });
    await startServer(lastGood);
  }

  // S8: poisoned cache entry is repaired.
  if (wants("poison-repair")) {
    const { page } = app;
    await page.goto(ORIGIN + "/", { waitUntil: "load" });
    const sentinel = "<!doctype html><title>POISON-SENTINEL</title><body>poison</body>";
    await safeEval(page, async (html) => {
      for (const name of await caches.keys()) {
        if (!name.includes("pages")) continue;
        const cache = await caches.open(name);
        for (const req of await cache.keys()) {
          if (new URL(req.url).pathname === "/") {
            await cache.put(req, new Response(html, { headers: { "content-type": "text/html" } }));
          }
        }
      }
    }, sentinel);
    await app.ctx.close();
    app = await launchApp();
    const t0 = Date.now();
    await app.page.goto(ORIGIN + "/", { waitUntil: "load" });
    await sleep(1000);
    const sawSentinel = await safeEval(app.page, () => document.title.includes("POISON-SENTINEL")).catch(() => false);
    const settled = await settleOn(app.page, dist, liveSlot, t0, 60000);
    const repaired = await safeEval(app.page, async () => {
      for (const name of await caches.keys()) {
        if (!name.includes("pages")) continue;
        const cache = await caches.open(name);
        for (const req of await cache.keys()) {
          if (new URL(req.url).pathname === "/") {
            const text = await (await cache.match(req)).clone().text();
            if (text.includes("POISON-SENTINEL")) return false;
          }
        }
      }
      return true;
    });
    record("poison-repair", settled.landed && repaired, {
      sawSentinelFirst: sawSentinel, landedMs: settled.ms, cacheRepaired: repaired, loads: settled.loads,
    });
  }

  // S9: an update never discards unsaved user input.
  if (wants("unsaved-input")) {
    const { page } = app;
    await page.goto(ORIGIN + "/chat", { waitUntil: "load" });
    const conversation = page.locator('a[href^="/chat/"]:visible').first();
    if (await conversation.count()) await conversation.click({ timeout: 3000 }).catch(() => {});
    await sleep(1200);
    const field = page.locator('input[placeholder*="essage"]:visible, textarea:visible, input[type="text"]:visible, input:not([type]):visible').first();
    await field.click({ timeout: 5000 });
    await field.pressSequentially("half-written draft");
    const old = liveSlot;
    const target = old === "A" ? "B" : "A";
    await swapTo(target);
    await sleep(THROTTLE_WAIT_MS);
    const valueBeforeSignals = await field.inputValue().catch(() => null);
    const t0 = Date.now();
    const fire = () => safeEval(page, () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      window.dispatchEvent(new Event("online"));
    });
    await fire();
    await sleep(7000);
    const loadsWhileDirty = await loadsSince(page, t0);
    const buildWhileDirty = await domBuild(page, dist);
    const valueKept = await field.inputValue().catch(() => null);
    await field.fill("");
    await sleep(500);
    await fire();
    const settled = await settleOn(page, dist, target, t0, 60000);
    record("unsaved-input",
      valueBeforeSignals === "half-written draft"
        && loadsWhileDirty.length === 0 && buildWhileDirty === old && valueKept === "half-written draft"
        && settled.landed && reloadsIn(settled.loads) === 1,
      { from: old, to: target, valueBeforeSignals, loadsWhileDirty: loadsWhileDirty.length, buildWhileDirty, valueKept,
        landedAfterClearMs: settled.ms, reloads: reloadsIn(settled.loads), loads: settled.loads });
  }

  // S10: slow network — cold start must fall back to the cached shell within
  // the navigation bound instead of hanging or showing offline.html.
  if (wants("slow-network")) {
    await app.ctx.close();
    shape.delayMs = 6000; // beyond the worker's 3.5 s navigation timeout
    app = await launchApp();
    const { page } = app;
    const t0 = Date.now();
    await page.goto(ORIGIN + "/", { waitUntil: "load", timeout: 30000 }).catch(() => {});
    const ms = Date.now() - t0;
    const state = await safeEval(page, () => ({
      isOfflinePage: document.title.startsWith("Offline"),
      hasAppRoot: !!document.querySelector(".app-frame, main, nav"),
      controller: !!navigator.serviceWorker?.controller,
    }));
    const b = await domBuild(page, dist);
    shape.delayMs = 0;
    // Bound must sit BELOW the injected delay: only the worker's 3.5 s
    // navigation timeout falling back to cache can beat it, so a missing or
    // broken worker turns this red.
    record("slow-network", !state.isOfflinePage && state.hasAppRoot && state.controller === true && b === liveSlot && ms < 6000, {
      liveBuild: liveSlot, domBuild: b, ms, state, injectedDelayMs: 6000,
    });
  }

  // S11: flapping connection — every 2nd request dropped; navigation still
  // lands a usable app view every time.
  if (wants("flaky-network")) {
    const { page } = app;
    // WebKit retries a dropped request on a kept-alive connection, so a 50%
    // drop is always survivable even without a worker. The no-sw negative
    // control therefore drops EVERY request — only a worker's cache fallback
    // can land a navigation then.
    shape.dropEveryNth = MUTATE === "no-sw" ? 1 : 2;
    const visits = [];
    for (const route of ["/", "/balances", "/groups"]) {
      await page.goto(ORIGIN + route, { waitUntil: "load", timeout: 30000 }).catch(() => {});
      await sleep(500);
      const state = await safeEval(page, () => ({
        path: location.pathname,
        isOfflinePage: document.title.startsWith("Offline"),
        hasAppRoot: !!document.querySelector(".app-frame, main, nav"),
      })).catch((e) => ({ error: String(e) }));
      // A failed navigation that leaves the previous page on screen must not
      // count as surviving the flap: the landed path has to match.
      state.pathOk = state.path === route;
      visits.push(state);
    }
    shape.dropEveryNth = 0;
    shape.dropCounter = 0;
    record("flaky-network", visits.every((v) => v.hasAppRoot === true && v.isOfflinePage === false && v.pathOk === true), { visits });
  }

  // S12: the app survives Cache Storage eviction, and a lost registration,
  // without a reinstall.
  if (wants("evicted-storage")) {
    let { page } = app;
    await safeEval(page, async () => {
      for (const key of await caches.keys()) await caches.delete(key);
    });
    await app.ctx.close();
    app = await launchApp();
    page = app.page;
    let t0 = Date.now();
    await page.goto(ORIGIN + "/", { waitUntil: "load" });
    const afterEviction = await safeEval(page, async () => ({
      hasAppRoot: !!document.querySelector(".app-frame, main, nav"),
      controller: !!navigator.serviceWorker?.controller,
      cachesRepopulated: (await caches.keys()).length,
    }));
    const evictionMs = Date.now() - t0;
    await safeEval(page, async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) await registration.unregister();
      for (const key of await caches.keys()) await caches.delete(key);
    });
    await app.ctx.close();
    app = await launchApp();
    page = app.page;
    t0 = Date.now();
    await page.goto(ORIGIN + "/", { waitUntil: "load" });
    await page.evaluate(() =>
      Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(r, 10000))])
    ).catch(() => {});
    await sleep(1500);
    const afterUnregister = await safeEval(page, async () => ({
      hasAppRoot: !!document.querySelector(".app-frame, main, nav"),
      controllerAfterReinstall: !!navigator.serviceWorker?.controller || !!(await navigator.serviceWorker.getRegistration())?.active,
      cachesRepopulated: (await caches.keys()).length,
    }));
    record("evicted-storage",
      afterEviction.hasAppRoot && afterEviction.controller && afterEviction.cachesRepopulated > 0
        && afterUnregister.hasAppRoot && afterUnregister.controllerAfterReinstall && afterUnregister.cachesRepopulated > 0,
      { afterEviction, evictionMs, afterUnregister });
  }

  // S13: total origin usage after a full browse stays under the written
  // budget, and the persistent-storage request outcome is recorded.
  if (wants("storage-budget")) {
    const BUDGET_BYTES = 25 * 1024 * 1024; // written budget: 25 MB
    const { page } = app;
    for (const route of ["/", "/balances", "/groups", "/expenses", "/activity", "/chat", "/settings"]) {
      await page.goto(ORIGIN + route, { waitUntil: "load" }).catch(() => {});
      await sleep(400);
    }
    if (MUTATE === "bloat-storage") {
      // Negative control: stuff the cache past the budget so the usage
      // assertion is shown able to fail.
      await safeEval(page, async () => {
        const cache = await caches.open("splitwisest-static-v8");
        await cache.put("/__bloat__", new Response(new Uint8Array(30 * 1024 * 1024)));
      });
    }
    const usage = await safeEval(page, async () => {
      const estimate = await navigator.storage.estimate();
      const perCache = {};
      for (const name of await caches.keys()) {
        perCache[name] = (await (await caches.open(name)).keys()).length;
      }
      return {
        usage: estimate.usage,
        quota: estimate.quota,
        persisted: navigator.storage.persisted ? await navigator.storage.persisted() : null,
        perCache,
      };
    });
    record("storage-budget", typeof usage.usage === "number" && usage.usage < BUDGET_BYTES, {
      budgetBytes: BUDGET_BYTES, ...usage,
    });
  }

  await app?.ctx.close();
  await stopServer();
  await stopProxy();

  const failed = results.filter((r) => !r.pass);
  log({ summary: true, total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.scenario) });
  process.exitCode = failed.length ? 1 : 0;
}

// ---------- migration test: old production worker -> new design ----------

function buildOldSlot(ref) {
  const oldTree = join(HDIR, "oldtree");
  if (existsSync(join(HDIR, "build-O", "harness-info.json"))) return;
  console.error(`[harness] building OLD ref ${ref} in a worktree…`);
  spawnSync("git", ["worktree", "remove", "--force", oldTree], { cwd: ROOT, stdio: "ignore" });
  let res = spawnSync("git", ["worktree", "add", "--force", oldTree, ref], { cwd: ROOT, stdio: "inherit" });
  if (res.status !== 0) throw new Error("worktree add failed");
  res = spawnSync("pnpm", ["install"], { cwd: oldTree, stdio: "inherit" });
  if (res.status !== 0) throw new Error("pnpm install in old tree failed");
  res = spawnSync("pnpm", ["build"], {
    cwd: oldTree,
    env: { ...process.env, GITHUB_SHA: "c".repeat(40) },
    stdio: "inherit",
  });
  if (res.status !== 0) throw new Error("old build failed");
  const dest = join(HDIR, "build-O");
  rmSync(dest, { recursive: true, force: true });
  renameSync(join(oldTree, ".next"), dest);
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const pth = join(dir, e);
      if (statSync(pth).isDirectory()) walk(pth);
      else files.push("/_next/static/" + relative(join(dest, "static"), pth));
    }
  };
  walk(join(dest, "static"));
  writeFileSync(join(dest, "harness-sw.js"), readFileSync(join(oldTree, "public/sw.js")));
  const info = { slot: "O", sha: "c".repeat(40), buildId: readFileSync(join(dest, "BUILD_ID"), "utf8").trim(), staticFiles: files };
  writeFileSync(join(dest, "harness-info.json"), JSON.stringify(info));
  spawnSync("git", ["worktree", "remove", "--force", oldTree], { cwd: ROOT, stdio: "ignore" });
}

async function migrateTest() {
  buildOldSlot(flag("ref", "7201b9f"));
  const infoO = loadInfo("O");
  const infoA = loadInfo("A");
  const dist = distinguishers(infoO, infoA); // label A = old build, label B = new build
  BUILD_IDS = { A: infoO.buildId, B: infoA.buildId };
  await startProxy();
  await startServer("O");
  const creds = await seedCreds();
  let app = await launchApp({ fresh: true });
  await app.page.goto(ORIGIN + "/", { waitUntil: "load" });
  await sleep(1500);
  await login(app.page, creds);
  await app.page.goto(ORIGIN + "/", { waitUntil: "load" });
  await app.page.evaluate(() =>
    Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(r, 8000))])
  ).catch(() => {});
  await sleep(2500);
  const before = await safeEval(app.page, async () => ({
    cacheNames: await caches.keys(),
    controller: !!navigator.serviceWorker?.controller,
  }));
  await app.ctx.close();
  await swapTo("A");
  app = await launchApp();
  const t0 = Date.now();
  await app.page.goto(ORIGIN + "/", { waitUntil: "load" });
  const settled = await settleOn(app.page, dist, "B", t0, 90000);
  await sleep(3000);
  const dump = await cacheDump(app.page, dist, { A: infoO, B: infoA });
  const stale = staleCount(dump, "A", infoA);
  const names = Object.keys(dump);
  const oldNamesGone = !names.some((n) => /v[2467]$/.test(n));
  const probe = await standaloneProbe(app.page);
  const result = {
    scenario: "migration-old-to-new",
    pass: before.controller && settled.landed && reloadsIn(settled.loads) <= 1 && oldNamesGone && stale.length === 0,
    oldWorkerInstalled: before, probe, ms: settled.ms, reloads: reloadsIn(settled.loads),
    loads: settled.loads, cacheNamesAfter: names, staleEntries: stale.length, stale,
  };
  log(result);
  await app.ctx.close();
  await stopServer();
  await stopProxy();
  process.exitCode = result.pass ? 0 : 1;
}

// ---------- main ----------

try {
  if (cmd === "build" || cmd === "all") {
    mkdirSync(HDIR, { recursive: true });
    buildSlot("A");
    buildSlot("B");
  }
  if (cmd === "suite" || cmd === "all") await suite();
  if (cmd === "migrate-test") await migrateTest();
  if (cmd === "serve") {
    // Serve one slot behind the TLS proxy until killed (for perf runs).
    await startProxy();
    await startServer(args[1] || "A");
    console.error("[harness] serving; Ctrl-C to stop");
    await new Promise(() => {});
  }
  if (!["build", "suite", "all", "migrate-test", "serve"].includes(cmd)) {
    console.error("usage: pwa-swap-harness.mjs <build|suite|all> [--port N] [--scenario a,b] [--mutate name]");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  await stopServer();
  await stopProxy();
  // A lingering browser or socket handle must not hang the run after the
  // summary is printed; the exit code is already decided.
  process.exit(process.exitCode ?? 0);
}
