#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webkit, devices } from "playwright-core";

const base = process.env.SPLITWISEST_BROWSER_URL ?? "http://localhost:3391";
const scenario = process.argv[2] ?? "inject";
const profile = mkdtempSync(join(tmpdir(), "splitwisest-units-cache-"));
const password = "cache-check-password";
const created = { users: [], groups: [], expenses: [] };
const deleted = { groups: [], expenses: [] };
const cleanupGroups = [];
const cleanupExpenses = [];
let passed = false;
let detail = {};

async function api(path, cookies, body, method) {
  const res = await fetch(new URL(path, base), {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      ...(cookies?.length ? { cookie: cookies.map((c) => c.split(";")[0]).join("; ") } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  assert(res.ok, `${path}: ${res.status} ${text}`);
  return { json: text ? JSON.parse(text) : null, cookies: res.headers.getSetCookie?.() ?? [] };
}

async function setup(label) {
  const suffix = Math.random().toString(16).slice(2, 10);
  const signup = await api("/api/auth/signup", null, { username: `cache_${label}_${suffix}`, displayName: `Cache ${label}`, password });
  const me = await api("/api/me", signup.cookies);
  const owner = { id: Number(me.json.user.id), cookies: signup.cookies };
  created.users.push(owner.id);
  const groupName = `Cache group ${label} ${suffix}`;
  const group = await api("/api/groups", owner.cookies, { name: groupName, currency: "USD" });
  created.groups.push(group.json.id);
  cleanupGroups.push({ id: group.json.id, owner });
  const unit = await api(`/api/groups/${group.json.id}/units`, owner.cookies, { name: `cache-unit-${label}` });
  const expense = await api(`/api/groups/${group.json.id}/expenses`, owner.cookies, {
    title: `Fresh cache proof ${label}`, amountCents: 100, currency: "USD", unitId: unit.json.id,
    date: new Date().toISOString().slice(0, 10), payerId: owner.id, notes: "", splitMethod: "equal",
    participants: [{ userId: owner.id }],
  });
  created.expenses.push(expense.json.id);
  cleanupExpenses.push({ id: expense.json.id, owner });
  return { owner, group: { ...group.json, name: groupName }, unit: unit.json, expense: expense.json };
}

const oldDetail = (group) => ({
  group: { id: group.id, name: group.name, currency: "USD", autoReconcileUnits: true },
  members: [], balances: [], suggestions: [],
});

async function launch(cookies) {
  const context = await webkit.launchPersistentContext(profile, {
    ...(devices["iPhone 16 Pro"] ?? devices["iPhone 15 Pro"]),
    serviceWorkers: "allow",
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { get: () => true, configurable: true });
  });
  await context.addCookies(cookies.map((cookie) => {
    const [pair] = cookie.split(";");
    const [name, ...value] = pair.split("=");
    return {
      name, value: value.join("="), domain: new URL(base).hostname, path: "/",
      secure: base.startsWith("https://"), sameSite: "Lax",
    };
  }));
  const page = context.pages()[0] ?? await context.newPage();
  return { context, page };
}

async function buildId(page) {
  await page.goto(new URL("/", base).href, { waitUntil: "load" });
  const id = await page.evaluate(() => document.querySelector('meta[name="build-id"]')?.getAttribute("content") ?? "");
  assert(id, "build-id meta tag was empty");
  return id;
}

async function cleanup() {
  for (const group of cleanupGroups) {
    try {
      await api(`/api/groups/${group.id}`, group.owner.cookies, undefined, "DELETE");
      deleted.groups.push(group.id);
    } catch {}
  }
  for (const expense of cleanupExpenses) {
    try {
      await api(`/api/expenses/${expense.id}`, expense.owner.cookies, undefined, "DELETE");
      deleted.expenses.push(expense.id);
    } catch {}
  }
}

try {
  if (scenario === "isolation") {
    const a = await setup("a");
    const b = await setup("b");
    const watch = (context, marker) => context.addInitScript((text) => {
      const look = () => {
        if (document.body?.innerText.includes(text)) sessionStorage.setItem("units-cache-seen", "1");
      };
      new MutationObserver(look).observe(document, { childList: true, subtree: true, characterData: true });
    }, marker);
    const seen = (page) => page.evaluate(() => sessionStorage.getItem("units-cache-seen") === "1");
    const control = await launch(b.owner.cookies);
    const build = await buildId(control.page);
    const cachedName = `Cached only ${b.group.id}`;
    const ownSeed = JSON.stringify({
      owner: String(b.owner.id), build,
      entries: [["/api/groups", { groups: [{ id: b.group.id, name: cachedName, currency: "USD" }] }, Date.now()]],
    });
    await control.context.addInitScript((value) => {
      if (!sessionStorage.getItem("units-cache-seeded")) {
        sessionStorage.setItem("units-cache-seeded", "1");
        localStorage.setItem("splitwisest.read-cache.v1", value);
      }
    }, ownSeed);
    await watch(control.context, cachedName);
    await control.page.goto(new URL("/groups", base).href, { waitUntil: "load" });
    await control.page.waitForTimeout(1500);
    const controlPainted = await seen(control.page);
    await control.context.close();
    const iso = await launch(b.owner.cookies);
    await watch(iso.context, a.group.name);
    const seed = JSON.stringify({
      owner: String(a.owner.id), build,
      entries: [
        ["/api/groups", { groups: [{ id: a.group.id, name: a.group.name, currency: "USD" }] }, Date.now()],
        [`/api/groups/${a.group.id}`, oldDetail(a.group), Date.now()],
      ],
    });
    await iso.page.goto(new URL("/offline.html", base).href, { waitUntil: "load" });
    await iso.page.evaluate((value) => localStorage.setItem("splitwisest.read-cache.v1", value), seed);
    await iso.page.goto(new URL("/groups", base).href, { waitUntil: "load" });
    await iso.page.waitForTimeout(1500);
    const leaked = await seen(iso.page);
    await api(`/api/groups/${b.group.id}/expenses`, b.owner.cookies, {
      title: "Isolation fresh proof", amountCents: 100, currency: "USD", unitId: b.unit.id,
      date: new Date().toISOString().slice(0, 10), payerId: b.owner.id, notes: "", splitMethod: "equal",
      participants: [{ userId: b.owner.id }],
    });
    await iso.page.goto(new URL(`/groups/${b.group.id}`, base).href, { waitUntil: "load" });
    await iso.page.waitForTimeout(1500);
    const fresh = (await iso.page.locator("body").innerText()).includes("Isolation fresh proof");
    detail = { controlPainted, leaked, fresh };
    passed = controlPainted && !leaked && fresh;
    await iso.context.close();
  } else {
    const data = await setup(scenario);
    const path = `/api/groups/${data.group.id}`;
    const { context, page } = await launch(data.owner.cookies);
    const seed = JSON.stringify({
      owner: String(data.owner.id), entries: [[path, oldDetail(data.group), Date.now()]],
    });
    await page.goto(new URL("/offline.html", base).href, { waitUntil: "load" });
    await page.evaluate((value) => localStorage.setItem("splitwisest.read-cache.v1", value), seed);
    const seeded = await page.evaluate(() => localStorage.getItem("splitwisest.read-cache.v1"));
    assert.equal(seeded, seed, "seed was not present before app navigation");
    const requests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === path) requests.push(request.url());
    });
    await page.goto(new URL(`/groups/${data.group.id}`, base).href, { waitUntil: "load" });
    await page.waitForTimeout(2500);
    const body = await page.locator("body").innerText();
    const crashed = body.includes("This page couldn’t load");
    const fresh = body.includes(data.unit.name) && !crashed;
    if (scenario === "negative") {
      detail = { seeded: Boolean(seeded), requests: requests.length, crashed, fresh };
      passed = requests.length === 0 || crashed;
    } else {
      detail = { seeded: Boolean(seeded), requests: requests.length, crashed, fresh, signedIn: !page.url().includes("/login") };
      passed = requests.length > 0 && fresh && detail.signedIn;
    }
    await context.close();
  }
} finally {
  await cleanup();
  rmSync(profile, { recursive: true, force: true });
}

console.log(JSON.stringify({ scenario, pass: passed, created, deleted, ...detail }));
process.exitCode = passed ? 0 : 1;
