import { strict as assert } from "node:assert";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { confirmMoneyQaApp, moneyQaTarget } from "./money-qa";

const { base: target, sql, password } = moneyQaTarget(true);
const base = target.origin;

type FixtureUser = { id: number; name: string; username: string };
type FixtureGroup = { id: number; currency: string };
const users: FixtureUser[] = [];
const fixtureGroups: FixtureGroup[] = [];
const evidence = resolve(process.env.SPLITWISEST_EVIDENCE_DIR ?? `${process.env.HOME}/.cache/splitwisest/money-form/evidence`);
const proofs: Record<string, unknown>[] = [];

async function api(context: BrowserContext, path: string, data?: unknown) {
  const response = data === undefined
    ? await context.request.get(`${base}${path}`)
    : await context.request.post(`${base}${path}`, { data });
  assert.equal(response.status(), 200, `${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}

async function setup(context: BrowserContext) {
  const suffix = randomBytes(6).toString("hex");
  for (const [index, name] of ["Ann", "Ben", "Cat"].entries()) {
    const username = `money_form_${suffix}_${index}`;
    await api(context, "/api/auth/signup", { username, displayName: name, password });
    const { user } = await api(context, "/api/me");
    users.push({ id: user.id, name, username });
  }
  for (const currency of ["USD", "JPY"]) {
    await api(context, "/api/auth/login", { username: users[0].username, password });
    const group = await api(context, "/api/groups", { name: `QA Shares ${currency} ${suffix}`, currency });
    fixtureGroups.push({ id: group.id, currency });
    for (const user of users.slice(1)) {
      await api(context, "/api/auth/login", { username: user.username, password });
      await api(context, "/api/groups/join", { code: group.inviteCode });
    }
  }
  await api(context, "/api/auth/login", { username: users[0].username, password });
}

async function cleanup() {
  const groupIds = fixtureGroups.map((g) => g.id);
  const userIds = users.map((u) => u.id);
  if (groupIds.length) await sql`DELETE FROM groups WHERE id = ANY(${groupIds})`;
  if (userIds.length) {
    await sql`DELETE FROM activity WHERE actor_id = ANY(${userIds})`;
    await sql`DELETE FROM users WHERE id = ANY(${userIds})`;
  }
  assert.equal(Number((await sql`SELECT count(*) AS count FROM groups WHERE id = ANY(${groupIds})`)[0].count), 0);
  assert.equal(Number((await sql`SELECT count(*) AS count FROM users WHERE id = ANY(${userIds})`)[0].count), 0);
  proofs.push({ action: "cleanup", groupsRemoved: groupIds.length, usersRemoved: userIds.length });
}

async function capture(page: Page, name: string) {
  await page.screenshot({ path: resolve(evidence, `${name}.png`), fullPage: true, animations: "disabled" });
  await writeFile(resolve(evidence, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
}

async function verifyShares(context: BrowserContext, page: Page) {
  async function stored(group: FixtureGroup, id: number, expected: readonly number[], weights: number[], label: string) {
    const { expense } = await api(context, `/api/expenses/${id}`);
    const ordered = users.map((user) => expense.shares.find((s: { userId: number }) => s.userId === user.id));
    const actual = ordered.map((s) => s.shareCents);
    const raw = ordered.map((s) => s.rawInput);
    const groupData = await api(context, `/api/groups/${group.id}`);
    const nets = users.map((user) => groupData.balances.find((b: { userId: number }) => b.userId === user.id).netCents);
    const expectedNets = expected.map((cents, index) => (index === 0 ? expense.amountCents : 0) - cents);
    const rows = await sql`SELECT user_id, net_cents FROM group_balance_rows(${group.id})`;
    const sqlNets = users.map((user) => Number(rows.find((r) => Number(r.user_id) === user.id)?.net_cents));
    proofs.push({ action: label, currency: group.currency, actual, expected, raw, weights, nets, expectedNets, sqlNets });
    assert.deepEqual(actual, expected, `${label}: stored cents`);
    assert.deepEqual(raw, weights, `${label}: stored weights`);
    assert.equal(actual.reduce((a, b) => a + b, 0), expense.amountCents, `${label}: total preserved`);
    assert.deepEqual(nets, expectedNets, `${label}: API balances`);
    assert.deepEqual(sqlNets, expectedNets, `${label}: SQL balances`);
    assert.equal(nets.reduce((a, b) => a + b, 0), 0, `${label}: balances sum to zero`);
    if (group.currency === "JPY") assert(actual.every((n) => n % 100 === 0), `${label}: whole yen`);
    console.log(`PASS ${label}: cents=${actual.join("/")} weights=${raw.join("/")} nets=${nets.join("/")}`);
  }
  async function openEdit(title: string, weights: string[]) {
    await page.getByRole("button", { name: `View ${title}`, exact: true }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit expense", exact: true });
    await edit.waitFor();
    for (const [index, user] of users.entries()) {
      await page.waitForFunction(({ name, value }) => document.querySelector<HTMLInputElement>(`input[aria-label="Shares for ${name}"]`)?.value === value, { name: user.name, value: weights[index] });
      assert.equal(await edit.getByLabel(`Shares for ${user.name}`, { exact: true }).inputValue(), weights[index]);
    }
    return edit;
  }
  for (const [currency, amount, expected] of [["USD", "40.00", [2000, 1000, 1000]], ["JPY", "101", [5100, 2500, 2500]]] as const) {
    const group = fixtureGroups.find((g) => g.currency === currency)!;
    const title = `${currency} proportional shares`;
    await page.goto(`${base}/groups/${group.id}`);
    await page.locator('button[aria-label="Add expense"]').click();
    const form = page.getByRole("dialog", { name: "Add expense", exact: true });
    await form.locator("#expense-amount").fill(amount);
    await form.getByLabel("Description", { exact: true }).fill(title);
    await form.getByRole("radio", { name: "Shares", exact: true }).click();
    for (const user of users) {
      await form.getByRole("checkbox", { name: user.name, exact: true }).check();
      assert.equal(await form.getByLabel(`Shares for ${user.name}`, { exact: true }).inputValue(), "");
    }
    await form.getByLabel("Shares for Ann", { exact: true }).fill("2");
    await form.getByText("4 total shares", { exact: true }).waitFor();
    await capture(page, currency === "USD" ? "after-form" : "yen-form");
    const response = page.waitForResponse((r) => r.url().endsWith(`/api/groups/${group.id}/expenses`) && r.request().method() === "POST");
    await form.getByRole("button", { name: "Add expense", exact: true }).click();
    const saved = await response;
    assert.equal(saved.status(), 200, await saved.text());
    const id = (await saved.json()).id;
    await page.getByRole("button", { name: `View ${title}`, exact: true }).waitFor();
    await stored(group, id, expected, [2, 1, 1], `${currency} blank shares save`);
    await capture(page, currency === "USD" ? "after-saved" : "yen-saved");
    await page.getByRole("tab", { name: "Balances", exact: true }).click();
    for (const user of users.slice(1)) {
      const payment = page.getByRole("button", { name: `Record payment: ${user.name} pays Ann`, exact: true });
      await payment.waitFor();
      if (currency === "USD") assert.match(await payment.locator("..").innerText(), /\$10\.00/);
    }
    await capture(page, currency === "USD" ? "after-balances" : "yen-balances");
    await page.getByRole("tab", { name: "Expenses", exact: true }).click();
    let edit = await openEdit(title, ["2", "1", "1"]);
    let updated = page.waitForResponse((r) => r.url().endsWith(`/api/expenses/${id}`) && r.request().method() === "PATCH");
    await edit.getByRole("button", { name: "Save changes", exact: true }).click();
    assert.equal((await updated).status(), 200);
    await page.reload();
    await stored(group, id, expected, [2, 1, 1], `${currency} unchanged edit and reload`);
    edit = await openEdit(title, ["2", "1", "1"]);
    await capture(page, currency === "USD" ? "after-edit-reload" : "yen-edit-reload");
    await edit.getByLabel("Shares for Ben", { exact: true }).fill("9");
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();
    edit = await openEdit(title, ["2", "1", "1"]);
    await edit.locator("#expense-amount").fill(currency === "USD" ? "48" : "103");
    updated = page.waitForResponse((r) => r.url().endsWith(`/api/expenses/${id}`) && r.request().method() === "PATCH");
    await edit.getByRole("button", { name: "Save changes", exact: true }).click();
    assert.equal((await updated).status(), 200);
    await page.reload();
    await stored(group, id, currency === "USD" ? [2400, 1200, 1200] : [5100, 2600, 2600], [2, 1, 1], `${currency} changed amount and reload`);
    edit = await openEdit(title, ["2", "1", "1"]);
    for (const user of users) await edit.getByLabel(`Shares for ${user.name}`, { exact: true }).fill("");
    await edit.getByText("3 total shares", { exact: true }).waitFor();
    await edit.locator("#expense-amount").fill(currency === "USD" ? "30" : "100");
    updated = page.waitForResponse((r) => r.url().endsWith(`/api/expenses/${id}`) && r.request().method() === "PATCH");
    await edit.getByRole("button", { name: "Save changes", exact: true }).click();
    assert.equal((await updated).status(), 200);
    await page.reload();
    await stored(group, id, currency === "USD" ? [1000, 1000, 1000] : [3400, 3300, 3300], [1, 1, 1], `${currency} equal blank weights`);
    const { expense } = await api(context, `/api/expenses/${id}`);
    assert.equal((await context.request.delete(`${base}/api/expenses/${id}?expectedUpdatedAt=${encodeURIComponent(expense.updatedAt)}`)).status(), 200);
  }
}

async function main() {
  const failures: string[] = [];
  await mkdir(evidence, { recursive: true });
  const feature = process.env.SPLITWISEST_MONEY_FORM_FEATURE ?? "all";
  assert(["shares", "all"].includes(feature), "SPLITWISEST_MONEY_FORM_FEATURE must be shares or all");
  let failedPage: Page | undefined;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SPLITWISEST_CHROMIUM_PATH });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block", viewport: { width: 430, height: 1100 } });
    await confirmMoneyQaApp(sql, async (cookie) => (await context.request.get(`${base}/api/me`, { headers: { cookie } })).json());
    await setup(context);
    const page = await context.newPage();
    failedPage = page;
    page.setDefaultTimeout(30_000);
    await verifyShares(context, page);
    if (feature === "shares") return;
    const yen = fixtureGroups.find((g) => g.currency === "JPY")!;
    await page.goto(`${base}/groups/${yen.id}`);
    await page.locator('button[aria-label="Add expense"]').click();
    const form = page.getByRole("dialog", { name: "Add expense", exact: true });
    await form.getByRole("radio", { name: "Itemized bill", exact: true }).click();
    await form.getByRole("button", { name: "Add item", exact: true }).click();
    await form.getByLabel("Item 1 name").fill("Yen dinner");
    await form.getByLabel("Item 1 amount").fill("101");
    await form.getByRole("button", { name: "Cat", exact: true }).click();
    await form.getByLabel("Description", { exact: true }).fill("Yen tax rounding");
    await form.getByRole("checkbox", { name: "Tax", exact: true }).check();
    await form.getByLabel("Tax rate", { exact: true }).fill("7.25");
    await form.getByRole("checkbox", { name: "Tip", exact: true }).check();
    await form.getByLabel("Tip rate", { exact: true }).fill("20");
    const value = await form.locator("#expense-amount").inputValue();
    console.log(`JPY 101 + 7.25% tax + 20% tip: preview=${value}, expected=128.00`);
    if (value !== "128.00") {
      failures.push(`whole-yen adjustment preview ${value} != 128.00`);
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
    } else {
    const response = page.waitForResponse((r) => r.url().endsWith(`/api/groups/${yen.id}/expenses`) && r.request().method() === "POST");
    await form.getByRole("button", { name: "Add expense", exact: true }).click();
    const saved = await response;
    assert.equal(saved.status(), 200, await saved.text());
    const id = (await saved.json()).id;
    const row = (await (await context.request.get(`${base}/api/expenses/${id}`)).json()).expense;
    assert.equal(row.amountCents, 12800);
    assert.equal(row.itemizedTaxCents, 700);
    assert.equal(row.itemizedTipCents, 2000);
    const removed = await context.request.delete(`${base}/api/expenses/${id}?expectedUpdatedAt=${encodeURIComponent(row.updatedAt)}`);
    assert.equal(removed.status(), 200);
    console.log("PASS whole-yen itemized preview, API save, stored adjustments, and delete");
    }
    const usd = fixtureGroups.find((g) => g.currency === "USD")!;
    const me = (await (await context.request.get(`${base}/api/me`)).json()).user;
    const fixture = await context.request.post(`${base}/api/groups/${usd.id}/expenses`, { data: {
      title: "Audit saved adjustment", amountCents: 99_999_999_999, currency: "USD", date: "2026-10-15",
      payerId: me.id, splitMethod: "itemized", participants: [{ userId: me.id }],
      items: [{ name: "Subtotal", amountCents: 99_999_999_998, participantIds: [me.id] }], itemizedTaxCents: 1,
    } });
    assert.equal(fixture.status(), 200, await fixture.text());
    const fixtureId = (await fixture.json()).id;
    try {
      await page.goto(`${base}/groups/${usd.id}`);
      await page.getByRole("button", { name: "View Audit saved adjustment", exact: true }).click();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "Edit expense", exact: true });
      await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[role="dialog"] #expense-amount')?.value);
      const editedTotal = await edit.locator("#expense-amount").inputValue();
      console.log(`Saved one-cent tax: preview=${editedTotal}, expected=999999999.99`);
      if (editedTotal !== "999999999.99") failures.push(`saved adjustment preview ${editedTotal} != 999999999.99`);
      else {
        await edit.getByLabel("Description", { exact: true }).fill("Audit saved adjustment renamed");
        const updated = page.waitForResponse((r) => r.url().endsWith(`/api/expenses/${fixtureId}`) && r.request().method() === "PATCH");
        await edit.getByRole("button", { name: "Save changes", exact: true }).click();
        assert.equal((await updated).status(), 200);
        const saved = (await (await context.request.get(`${base}/api/expenses/${fixtureId}`)).json()).expense;
        assert.equal(saved.amountCents, 99_999_999_999);
        assert.equal(saved.itemizedTaxCents, 1);
        console.log("PASS title edit preserves saved adjustment cents");
      }
    } finally {
      const row = (await (await context.request.get(`${base}/api/expenses/${fixtureId}`)).json()).expense;
      const removed = await context.request.delete(`${base}/api/expenses/${fixtureId}?expectedUpdatedAt=${encodeURIComponent(row.updatedAt)}`);
      assert.equal(removed.status(), 200);
    }
    await page.goto(`${base}/groups/${usd.id}`);
    await page.locator('button[aria-label="Add expense"]').click();
    const percentages = page.getByRole("dialog", { name: "Add expense", exact: true });
    await percentages.locator("#expense-amount").fill("10");
    await percentages.getByRole("radio", { name: "Percentages", exact: true }).click();
    await percentages.getByRole("checkbox", { name: "Ann", exact: true }).uncheck();
    await percentages.getByRole("checkbox", { name: "Ben", exact: true }).check();
    await percentages.getByRole("checkbox", { name: "Cat", exact: true }).check();
    await percentages.getByLabel("Percentages for Ben", { exact: true }).fill("50");
    await percentages.getByLabel("Percentages for Cat", { exact: true }).fill("50.0009");
    const invalidDisabled = await percentages.getByRole("button", { name: "Add expense", exact: true }).isDisabled();
    console.log(`Percentage total 100.0009: disabled=${invalidDisabled}, expected=true`);
    if (!invalidDisabled) failures.push("percentage preview accepts a total above 100");
    await percentages.getByLabel("Percentages for Cat", { exact: true }).fill("50");
    assert.equal(await percentages.getByRole("button", { name: "Add expense", exact: true }).isEnabled(), true);
    await percentages.getByRole("button", { name: "Cancel", exact: true }).click();
    for (const [method, first, second] of [["Exact amounts", "6.67", "3,33"], ["Shares", "2", "1"]]) {
      await page.locator('button[aria-label="Add expense"]').click();
      const split = page.getByRole("dialog", { name: "Add expense", exact: true });
      await split.locator("#expense-amount").fill("10");
      await split.getByLabel("Description", { exact: true }).fill(`Audit ${method} preview`);
      await split.getByRole("radio", { name: method, exact: true }).click();
      await split.getByRole("checkbox", { name: "Ann", exact: true }).uncheck();
      await split.getByRole("checkbox", { name: "Ben", exact: true }).check();
      await split.getByRole("checkbox", { name: "Cat", exact: true }).check();
      await split.getByLabel(`${method} for Cat`, { exact: true }).fill(first);
      await split.getByLabel(`${method} for Ben`, { exact: true }).fill(second);
      assert.equal(await split.getByRole("button", { name: "Add expense", exact: true }).isEnabled(), true);
      const response = page.waitForResponse((r) => r.url().endsWith(`/api/groups/${usd.id}/expenses`) && r.request().method() === "POST");
      await split.getByRole("button", { name: "Add expense", exact: true }).click();
      const saved = await response;
      assert.equal(saved.status(), 200, await saved.text());
      const id = (await saved.json()).id;
      const row = (await (await context.request.get(`${base}/api/expenses/${id}`)).json()).expense;
      assert.deepEqual(row.shares.map((s: { shareCents: number }) => s.shareCents).sort((a: number, b: number) => a - b), [333, 667]);
      assert.equal((await context.request.delete(`${base}/api/expenses/${id}?expectedUpdatedAt=${encodeURIComponent(row.updatedAt)}`)).status(), 200);
      console.log(`PASS ${method} preview, submission, stored shares, and delete`);
    }
    assert.deepEqual(failures, []);
  } catch (error) {
    proofs.push({ action: "failure", message: error instanceof Error ? error.message : String(error) });
    if (failedPage) await capture(failedPage, "failure");
    throw error;
  } finally {
    try { await cleanup(); }
    finally {
      await browser.close();
      await writeFile(resolve(evidence, "money-form-proof.json"), JSON.stringify(proofs, null, 2));
    }
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
