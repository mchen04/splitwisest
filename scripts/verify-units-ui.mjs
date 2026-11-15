import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { webkit } from "playwright-core";

const origin = process.env.UNITS_UI_ORIGIN ?? "http://127.0.0.1:3392";
const evidenceDir = resolve(process.env.UNITS_UI_EVIDENCE_DIR ?? "../splitwisest-units-ui-evidence");
assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname), "Use an isolated loopback app");
assert(relative(process.cwd(), evidenceDir).startsWith(".."), "Keep evidence outside git");
mkdirSync(evidenceDir, { recursive: true });

const suffix = randomBytes(4).toString("hex");
const password = randomBytes(24).toString("hex");
const results = [];
const errors = [];

async function api(path, cookie, body, method = body ? "POST" : "GET") {
  const res = await fetch(new URL(path, origin), {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  assert(res.ok, `${path}: ${res.status} ${text}`);
  return res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null;
}

async function signup(role) {
  const username = `units_ui_${role}_${suffix}`;
  const res = await fetch(new URL("/api/auth/signup", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, displayName: `Units UI ${role} ${suffix}`, password }),
  });
  assert(res.ok, `signup ${role}: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  assert(cookie, "signup cookie missing");
  const me = await api("/api/me", cookie);
  return { id: Number(me.user.id), cookie, username };
}

const owner = await signup("owner");
const friend = await signup("friend");
const groups = [];

async function createGroup(label) {
  const name = `Units UI ${label} ${suffix}`;
  const group = await api("/api/groups", owner.cookie, { name, currency: "USD" });
  await api("/api/groups/join", friend.cookie, { code: group.inviteCode });
  groups.push(group.id);
  return { id: group.id, name };
}

async function createUnitExpense(groupId, unitId, { title, amountCents, payerId }) {
  return api(`/api/groups/${groupId}/expenses`, owner.cookie, {
    title,
    amountCents,
    currency: "USD",
    unitId,
    date: localToday(),
    payerId,
    notes: "",
    splitMethod: "equal",
    participants: [{ userId: owner.id }, { userId: friend.id }],
  });
}

function localToday() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

const executablePath = process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE || (() => {
  try { return webkit.executablePath(); } catch { return undefined; }
})();
const browser = await webkit.launch(executablePath ? { executablePath } : {});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  colorScheme: "dark",
  hasTouch: true,
  ignoreHTTPSErrors: true,
  serviceWorkers: "block",
});
await context.addInitScript(() => Object.defineProperty(navigator, "standalone", { get: () => true }));
await context.addInitScript(() => {
  if (sessionStorage.getItem("units-ui-large-text") !== "1") return;
  const apply = () => { document.documentElement.style.fontSize = "150%"; };
  if (document.documentElement) apply();
  else document.addEventListener("DOMContentLoaded", apply, { once: true });
});
const token = owner.cookie.split("=").slice(1).join("=");
await context.addCookies([{ name: "sw_session", value: token, domain: new URL(origin).hostname, path: "/" }]);
const page = await context.newPage();
page.setDefaultTimeout(20000);
page.on("pageerror", (error) => errors.push(error.message));

async function settle() {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(250);
}

async function navigate(url) {
  await page.goto(url);
  await settle();
}

async function layout(name, screenshot = true) {
  const data = await page.evaluate(() => {
    const root = [...document.querySelectorAll("[role=dialog]")].at(-1) ?? document.querySelector("main") ?? document.body;
    const overflow = [];
    for (const element of root.querySelectorAll("input:not([type=hidden]),select,textarea,button,[role=radio]")) {
      if (!element.getClientRects().length) continue;
      const rect = element.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= innerHeight) continue;
      if (rect.left < -1 || rect.right > innerWidth + 1) {
        overflow.push({ label: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 40), rect });
      }
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      overflow,
    };
  });
  results.push({ name, ...data });
  if (screenshot) await page.screenshot({ path: resolve(evidenceDir, `${name}.png`), scale: "css" });
  assert.equal(data.overflow.length, 0, `${name}: controls overflow ${JSON.stringify(data.overflow)}`);
  assert(data.documentWidth <= data.viewport.width + 1, `${name}: document horizontal overflow`);
}

async function footerReachable(dialog) {
  const submit = dialog.locator("button[type=submit]");
  await submit.scrollIntoViewIfNeeded();
  const visible = await submit.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight &&
      element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  });
  assert(visible, "Sticky footer submit is reachable above the safe area");
}

async function runFlow(width, height, label, { largeText = false } = {}) {
  await page.setViewportSize({ width, height });
  const { id: groupId, name: groupName } = await createGroup(label);
  await navigate(`${origin}/groups`);
  await page.getByRole("link", { name: new RegExp(groupName) }).first().click();
  await page.waitForURL(`**/groups/${groupId}`);
  await settle();
  const trigger = page.locator("main").getByRole("button", { name: "Add expense", exact: true })
    .filter({ hasText: "Add expense" }).first();
  await trigger.waitFor();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Add expense", exact: true });
  await dialog.waitFor();

  const money = dialog.getByRole("radio", { name: "Money", exact: true });
  assert.equal(await money.getAttribute("aria-checked"), "true", "Money is the default denomination");
  assert(await dialog.getByLabel("Currency", { exact: true }).isVisible(), "Money shows the currency picker");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert(await trigger.evaluate((element) => element === document.activeElement), "Focus returns to the Add expense trigger");
  await trigger.click();
  await dialog.waitFor();

  await dialog.getByRole("radio", { name: "Custom unit", exact: true }).click();
  const newUnitButton = dialog.getByRole("button", { name: "New unit", exact: true });
  if (await newUnitButton.count()) await newUnitButton.click();
  const unitName = `chores-${label}-${suffix}`;
  await dialog.getByLabel("New unit name", { exact: true }).fill(unitName);
  const created = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === `/api/groups/${groupId}/units`);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  assert((await created).ok(), "Inline unit creation succeeds");
  await dialog.getByLabel("Unit", { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel("Unit", { exact: true }).inputValue() !== "", true, "The new unit is selected");
  const unitId = Number(await dialog.getByLabel("Unit", { exact: true }).inputValue());
  assert.equal(await dialog.getByLabel("Currency", { exact: true }).count(), 0, "Unit mode hides the currency picker");

  await dialog.getByLabel("Amount", { exact: true }).fill("3");
  await dialog.getByLabel("Description", { exact: true }).fill(`Unit UI ${label} ${suffix}`);
  await dialog.getByLabel("Date", { exact: true }).fill(localToday());
  if (largeText) await page.evaluate(() => { sessionStorage.setItem("units-ui-large-text", "1"); document.documentElement.style.fontSize = "150%"; });
  await footerReachable(dialog);
  await dialog.getByLabel("Unit", { exact: true }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await layout(`${label}-add-unit`, true);
  const saved = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === `/api/groups/${groupId}/expenses`);
  await dialog.getByRole("button", { name: "Add expense", exact: true }).click();
  assert((await saved).ok(), "Unit expense saves");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') === null), true, "Focus leaves the closed dialog");

  await page.locator('[data-group-tab="balances"]:visible').click();
  const unitHeading = page.getByRole("heading", { name: new RegExp(`^${unitName}\\s+simplified$`) });
  await unitHeading.waitFor();
  const unitCard = unitHeading.locator("..").locator("..");
  const record = unitCard.getByRole("button", { name: new RegExp(`Record ${unitName} payment`) }).first();
  await record.waitFor();
  await unitCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await layout(`${label}-balances`, true);

  await record.click();
  const settleDialog = page.getByRole("dialog", { name: "Settle up", exact: true });
  await settleDialog.waitFor();
  await page.waitForTimeout(350);
  assert.equal(await settleDialog.getByLabel("Currency", { exact: true }).count(), 0, "Unit settlement hides the currency picker");
  assert(await settleDialog.getByText(new RegExp(unitName)).first().isVisible(), "Unit settlement names the unit");
  await layout(`${label}-settle`, true);
  const paid = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === `/api/groups/${groupId}/settlements`);
  await settleDialog.getByRole("button", { name: /^Record / }).click();
  assert((await paid).ok(), "Unit settlement saves");
  await settleDialog.waitFor({ state: "hidden" });
  await page.getByText(`Nobody owes any ${unitName}.`, { exact: true }).waitFor();
  await layout(`${label}-paid`, true);

  await createUnitExpense(groupId, unitId, { title: "Unit A", amountCents: 800, payerId: owner.id });
  await createUnitExpense(groupId, unitId, { title: "Unit B", amountCents: 400, payerId: friend.id });
  await page.reload();
  await settle();
  await page.locator('[data-group-tab="balances"]:visible').click();

  await page.getByRole("button", { name: "Group menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Group settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Group settings", exact: true });
  await settings.waitFor();
  await settings.getByText("Custom units", { exact: true }).waitFor();
  await settings.getByText(unitName, { exact: true }).waitFor();
  await settings.getByText("Simplify unit balances", { exact: true }).waitFor();
  const toggle = settings.getByRole("checkbox");
  await toggle.waitFor();
  await page.waitForTimeout(350);
  await layout(`${label}-settings`, true);
  const before = await toggle.isChecked();
  const toggled = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/groups/${groupId}`);
  await toggle.click();
  assert((await toggled).ok(), "Reconcile toggle persists");
  assert.notEqual(await toggle.isChecked(), before, "Reconcile toggle changes");
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await settings.waitFor({ state: "hidden" });

  await page.locator('[data-group-tab="balances"]:visible').click();
  const offHeading = page.getByRole("heading", { name: new RegExp(`^${unitName}\\s+not simplified$`) });
  await offHeading.waitFor();
  const offCard = offHeading.locator("..").locator("..");
  const offRecords = offCard.getByRole("button", { name: new RegExp(`Record ${unitName} payment`) });
  await offRecords.nth(1).waitFor();
  await offCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  assert.equal(await offRecords.count(), 2, "OFF mode shows both directions");
  await layout(`${label}-off-balances`, true);

  await api(`/api/groups/${groupId}`, owner.cookie, undefined, "DELETE");
  results.push({ name: `${label}-flow`, groupId, unitName, passed: true });
}

try {
  const only = process.env.UNITS_UI_ONLY;
  const flows = [
    [320, 568, "320", {}],
    [390, 844, "390", {}],
    [393, 852, "393", {}],
    [1280, 900, "1280", {}],
    [390, 844, "390-large-text", { largeText: true }],
  ];
  const ran = [];
  for (const [width, height, label, options] of flows) {
    if (!only || only === label) {
      await runFlow(width, height, label, options);
      ran.push(label);
    }
  }
  assert(ran.length > 0, "No flow selected");
  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log(`Unit UI flows passed: ${ran.join(", ")}.`);
} catch (error) {
  await page.screenshot({ path: resolve(evidenceDir, "failure.png"), scale: "css" }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync(resolve(evidenceDir, "measurements.json"), JSON.stringify({ results, errors }, null, 2));
  for (const groupId of groups) {
    await fetch(new URL(`/api/groups/${groupId}`, origin), { method: "DELETE", headers: { cookie: owner.cookie } }).catch(() => {});
  }
  await browser.close();
}
