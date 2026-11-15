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
let passed = false;
let detail = {};

async function api(path, cookie, body) {
  const res = await fetch(new URL(path, base), {
    method: body ? "POST" : "GET",
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  assert(res.ok, `${path}: ${res.status} ${text}`);
  return { json: text ? JSON.parse(text) : null, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

async function setup(label) {
  const suffix = Math.random().toString(16).slice(2, 10);
  const signup = await api("/api/auth/signup", null, { username: `cache_${label}_${suffix}`, displayName: `Cache ${label}`, password });
  const me = await api("/api/me", signup.cookie);
  const owner = { cookie: signup.cookie, id: Number(me.json.user.id) };
  const group = await api("/api/groups", owner.cookie, { name: `Cache group ${suffix}`, currency: "USD" });
  const expense = await api(`/api/groups/${group.json.id}/expenses`, owner.cookie, {
    title: "Fresh cache proof", amountCents: 100, currency: "USD", date: new Date().toISOString().slice(0, 10),
    payerId: owner.id, notes: "", splitMethod: "equal", participants: [{ userId: owner.id }],
  });
  return { owner, group: group.json, expense: expense.json, suffix };
}

const oldDetail = (group) => ({
  group: { id: group.id, name: group.name, currency: "USD", autoReconcileUnits: true },
  members: [], balances: [], suggestions: [],
});

async function launch(cookie, seed) {
  const context = await webkit.launchPersistentContext(profile, {
    ...(devices["iPhone 16 Pro"] ?? devices["iPhone 15 Pro"]),
    serviceWorkers: "allow",
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(({ seedValue }) => {
    Object.defineProperty(navigator, "standalone", { get: () => true, configurable: true });
    if (seedValue) localStorage.setItem("splitwisest.read-cache.v1", seedValue);
  }, { seedValue: seed });
  await context.addCookies([{
    name: "sw_session", value: cookie.split("=").slice(1).join("="),
    domain: new URL(base).hostname, path: "/", secure: base.startsWith("https://"), sameSite: "Lax",
  }]);
  const page = context.pages()[0] ?? await context.newPage();
  return { context, page };
}

try {
  const data = await setup(scenario);
  const path = `/api/groups/${data.group.id}`;
  const seed = JSON.stringify({
    owner: String(data.owner.id),
    entries: [[path, oldDetail(data.group), Date.now()]],
  });
  if (scenario === "negative") {
    const { context, page } = await launch(data.owner.cookie, seed);
    await page.goto(new URL(`/groups/${data.group.id}`, base).href, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    detail = { stalePainted: (await page.locator("body").innerText()).includes(data.group.name) };
    passed = detail.stalePainted;
    await context.close();
  } else if (scenario === "isolation") {
    const { context, page } = await launch("sw_session=other-owner", seed);
    await page.goto(new URL("/groups", base).href, { waitUntil: "load" });
    await page.waitForTimeout(1000);
    detail = { leaked: (await page.locator("body").innerText()).includes(data.group.name) };
    passed = !detail.leaked;
    await context.close();
  } else {
    const { context, page } = await launch(data.owner.cookie, seed);
    const requests = [];
    page.on("request", (request) => {
      if (request.url().includes(path)) requests.push(request.url());
    });
    await page.goto(new URL(`/groups/${data.group.id}`, base).href, { waitUntil: "load" });
    await page.waitForTimeout(2500);
    const body = await page.locator("body").innerText();
    detail = {
      requests: requests.length,
      signedIn: !page.url().includes("/login"),
      rendered: body.includes(data.group.name) && !body.includes("This page couldn’t load"),
    };
    passed = detail.requests > 0 && detail.signedIn && detail.rendered;
    await context.close();
  }
} finally {
  rmSync(profile, { recursive: true, force: true });
}

console.log(JSON.stringify({ scenario, pass: passed, ...detail }));
process.exitCode = passed ? 0 : 1;
