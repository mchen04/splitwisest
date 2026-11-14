// Real local app + synthetic fixtures only. Keep fixtures and evidence outside git.
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
  const group = await api("/api/groups", owner.cookie, { name: `Units UI ${label} ${suffix}`, currency: "USD" });
  await api("/api/groups/join", friend.cookie, { code: group.inviteCode });
  groups.push(group.id);
  return group.id;
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
  const groupId = await createGroup(label);
  await navigate(`${origin}/groups/${groupId}`);
  const trigger = page.locator("main").getByRole("button", { name: "Add expense", exact: true }).first();
  await trigger.waitFor();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Add expense", exact: true });
  await dialog.waitFor();

  const money = dialog.getByRole("radio", { name: "Money", exact: true });
  assert.equal(await money.getAttribute("aria-checked"), "true", "Money is the default denomination");
  assert(await dialog.getByLabel("Currency", { exact: true }).isVisible(), "Money shows the currency picker");

  await dialog.getByRole("radio", { name: "Custom unit", exact: true }).click();
  await dialog.getByRole("button", { name: "New unit", exact: true }).click();
  const unitName = `chores-${label}-${suffix}`;
  await dialog.getByLabel("New unit name", { exact: true }).fill(unitName);
  const created = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === `/api/groups/${groupId}/units`);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  assert((await created).ok(), "Inline unit creation succeeds");
  await dialog.getByLabel("Unit", { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel("Unit", { exact: true }).inputValue() !== "", true, "The new unit is selected");
  assert.equal(await dialog.getByLabel("Currency", { exact: true }).count(), 0, "Unit mode hides the currency picker");

  await dialog.getByLabel("Amount", { exact: true }).fill("3");
  await dialog.getByLabel("Description", { exact: true }).fill(`Unit UI ${label} ${suffix}`);
  await dialog.getByLabel("Date", { exact: true }).fill(new Date().toISOString().slice(0, 10));
  if (largeText) await page.evaluate(() => { document.documentElement.style.fontSize = "150%"; });
  await footerReachable(dialog);
  await layout(`${label}-add-unit`, true);
  const saved = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === `/api/groups/${groupId}/expenses`);
  await dialog.getByRole("button", { name: "Add expense", exact: true }).click();
  assert((await saved).ok(), "Unit expense saves");
  await dialog.waitFor({ state: "hidden" });
  assert(await trigger.evaluate((element) => element === document.activeElement), "Focus returns to the Add expense trigger");
  if (largeText) await page.evaluate(() => { document.documentElement.style.fontSize = ""; });

  await page.locator('[data-group-tab="balances"]:visible').click();
  await page.getByText("Unit balances", { exact: true }).waitFor();
  await page.getByText(unitName, { exact: true }).first().waitFor();
  await layout(`${label}-balances`, true);

  const record = page.getByRole("button", { name: new RegExp(`Record ${unitName} payment`) }).first();
  await record.click();
  const settle = page.getByRole("dialog", { name: "Settle up", exact: true });
  await settle.waitFor();
  assert.equal(await settle.getByLabel("Currency", { exact: true }).count(), 0, "Unit settlement hides the currency picker");
  assert(await settle.getByText(new RegExp(unitName)).first().isVisible(), "Unit settlement names the unit");
  await layout(`${label}-settle`, true);
  const paid = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === `/api/groups/${groupId}/settlements`);
  await settle.getByRole("button", { name: /^Record / }).click();
  assert((await paid).ok(), "Unit settlement saves");
  await settle.waitFor({ state: "hidden" });

  await page.getByRole("button", { name: "Group menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Group settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Group settings", exact: true });
  await settings.waitFor();
  await settings.getByText("Custom units", { exact: true }).waitFor();
  await settings.getByText(unitName, { exact: true }).waitFor();
  const toggle = settings.getByRole("checkbox");
  const before = await toggle.isChecked();
  const toggled = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/groups/${groupId}`);
  await toggle.click();
  assert((await toggled).ok(), "Reconcile toggle persists");
  assert.notEqual(await toggle.isChecked(), before, "Reconcile toggle changes");
  await layout(`${label}-settings`, true);
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await settings.waitFor({ state: "hidden" });

  await api(`/api/groups/${groupId}`, owner.cookie, undefined, "DELETE");
  results.push({ name: `${label}-flow`, groupId, unitName, passed: true });
}

try {
  await runFlow(320, 568, "320");
  await runFlow(390, 844, "390");
  await runFlow(393, 852, "393");
  await runFlow(1280, 900, "1280");
  await runFlow(390, 844, "390-large-text", { largeText: true });
  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log("Unit UI flows passed at 320, 390, 393, 1280, dark mode, and larger text.");
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
