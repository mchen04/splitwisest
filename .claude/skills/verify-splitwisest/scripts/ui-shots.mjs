#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { webkit, devices } from "playwright-core";

const origin = process.env.SPLITWISEST_BASE_URL ?? "http://localhost:3391";
const out = process.env.SPLITWISEST_SHOTS_DIR;
const label = process.argv[2] ?? "shots";
if (!out) throw new Error("set SPLITWISEST_SHOTS_DIR outside the repository");
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) throw new Error("loopback app only");
mkdirSync(join(out, label), { recursive: true });
const suffix = `${label.replace(/[^a-z0-9]/gi, "").slice(0, 8)}${Date.now().toString(36)}`;
const password = `shots-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function api(path, { cookie, body, method } = {}) {
  const res = await fetch(origin + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text.slice(0, 200)}`);
  return { json: text ? JSON.parse(text) : {}, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

async function user(name) {
  const r = await api("/api/auth/signup", { body: { username: `shot_${name.toLowerCase()}_${suffix}`, password, displayName: name } });
  const me = await api("/api/me", { cookie: r.cookie });
  return { cookie: r.cookie, id: Number(me.json.user.id), name };
}

const ann = await user("Ann");
const ben = await user("Ben");
const cat = await user("Cat");
const group = await api("/api/groups", { cookie: ann.cookie, body: { name: "Lake cabin", currency: "USD" } });
const groupId = Number(group.json.id);
for (const m of [ben, cat]) await api("/api/groups/join", { cookie: m.cookie, body: { code: String(group.json.inviteCode) } });
const today = new Date().toISOString().slice(0, 10);
const everyone = [ann, ben, cat].map((m) => ({ userId: m.id }));
await api(`/api/groups/${groupId}/expenses`, { cookie: ann.cookie, body: { title: "Groceries", amountCents: 9000, currency: "USD", date: today, payerId: ann.id, splitMethod: "equal", participants: everyone } });
await api(`/api/groups/${groupId}/expenses`, { cookie: ben.cookie, body: { title: "Firewood", amountCents: 2400, currency: "USD", date: today, payerId: ben.id, splitMethod: "equal", participants: everyone } });
let unitId = null;
const unitRes = await fetch(`${origin}/api/groups/${groupId}/units`, { method: "POST", headers: { cookie: ann.cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "drinks" }) });
if (unitRes.ok) {
  unitId = Number((await unitRes.json()).id);
  await api(`/api/groups/${groupId}/expenses`, { cookie: ben.cookie, body: { title: "Bar round", amountCents: 600, currency: "USD", unitId, date: today, payerId: ben.id, splitMethod: "equal", participants: everyone } });
  await api(`/api/groups/${groupId}/expenses`, { cookie: ann.cookie, body: { title: "Coffee run", amountCents: 300, currency: "USD", unitId, date: today, payerId: ann.id, splitMethod: "equal", participants: everyone } });
}
writeFileSync(join(out, label, "fixture.json"), JSON.stringify({ origin, groupId, unitId, users: [ann.id, ben.id, cat.id] }));

const browser = await webkit.launch();
const variants = [
  { name: "390-light", viewport: { width: 390, height: 844 }, colorScheme: "light", mobile: true },
  { name: "390-dark", viewport: { width: 390, height: 844 }, colorScheme: "dark", mobile: true },
  { name: "320-light", viewport: { width: 320, height: 640 }, colorScheme: "light", mobile: true },
  { name: "1280-light", viewport: { width: 1280, height: 860 }, colorScheme: "light", mobile: false },
];
const report = [];
for (const v of variants) {
  const context = await browser.newContext({
    ...(v.mobile ? devices["iPhone 13"] : {}),
    viewport: v.viewport, colorScheme: v.colorScheme, serviceWorkers: "block",
  });
  if (v.mobile) await context.addInitScript(() => Object.defineProperty(navigator, "standalone", { get: () => true }));
  const [name, value] = ann.cookie.split("=");
  await context.addCookies([{ name, value, url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const shot = async (step) => {
    await page.waitForTimeout(400);
    const file = join(out, label, `${v.name}-${step}.png`);
    await page.screenshot({ path: file });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    report.push({ variant: v.name, step, file, overflow });
  };
  await page.goto(`${origin}/groups/${groupId}`);
  await page.getByText("Groceries").first().waitFor();
  await shot("expenses");
  await page.getByRole("button", { name: "Add expense", exact: true }).filter({ visible: true }).first().click();
  await page.getByRole("dialog", { name: "Add expense" }).waitFor();
  await shot("add-expense");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Add expense" }).waitFor({ state: "hidden" });
  await page.getByRole("tab", { name: "Balances" }).click();
  await page.waitForTimeout(300);
  await shot("balances");
  if (unitId) {
    await page.getByRole("heading", { name: "drinks" }).first().scrollIntoViewIfNeeded().catch(() => {});
    await shot("unit-balances");
    await page.goto(`${origin}/groups`);
    await page.getByText("Lake cabin").first().waitFor();
    await shot("groups-list");
    await page.goto(`${origin}/groups/${groupId}`);
    await page.getByText("Groceries").first().waitFor();
  }
  await page.getByRole("button", { name: "Group menu" }).click();
  await page.getByRole("menuitem", { name: "Group settings" }).click();
  await page.getByRole("dialog", { name: "Group settings" }).waitFor();
  await shot("settings");
  await context.close();
}
await browser.close();
writeFileSync(join(out, label, "report.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ label, shots: report.length, maxOverflow: Math.max(...report.map((r) => r.overflow)) }));
