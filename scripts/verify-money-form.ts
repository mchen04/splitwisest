import { randomBytes } from "node:crypto";
import { strict as assert } from "node:assert";
import { chromium } from "playwright-core";

const base = process.env.SPLITWISEST_BROWSER_URL ?? "https://127.0.0.1:3740";
const target = new URL(base);
assert.equal(target.hostname, "127.0.0.1");
assert(/^374[0-9]$/.test(target.port));

async function main() {
  const failures: string[] = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" });
    const login = await context.request.post(`${base}/api/auth/login`, { data: { username: "money_audit_0", password: process.env.SPLITWISEST_MONEY_QA_PASSWORD ?? randomBytes(32).toString("hex") } });
    assert.equal(login.status(), 200);
    const groups = await (await context.request.get(`${base}/api/groups`)).json();
    const yen = groups.groups.find((g: { currency: string }) => g.currency === "JPY");
    assert(yen, "Run verify-money-ledger first");
    const page = await context.newPage();
    await page.goto(`${base}/groups/${yen.id}`);
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Add expense", exact: true });
    await form.getByRole("radio", { name: "Itemized bill", exact: true }).click();
    await form.getByRole("button", { name: "Add item", exact: true }).click();
    await form.getByLabel("Item 1 name").fill("Yen dinner");
    await form.getByLabel("Item 1 amount").fill("101");
    await form.getByRole("button", { name: "Audit 3", exact: true }).click();
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
    const usd = groups.groups.find((g: { currency: string }) => g.currency === "USD");
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
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    const percentages = page.getByRole("dialog", { name: "Add expense", exact: true });
    await percentages.locator("#expense-amount").fill("10");
    await percentages.getByRole("radio", { name: "Percentages", exact: true }).click();
    await percentages.getByRole("checkbox", { name: "Audit 0", exact: true }).uncheck();
    await percentages.getByRole("checkbox", { name: "Audit 2", exact: true }).check();
    await percentages.getByRole("checkbox", { name: "Audit 3", exact: true }).check();
    await percentages.getByLabel("Percentages for Audit 2", { exact: true }).fill("50");
    await percentages.getByLabel("Percentages for Audit 3", { exact: true }).fill("50.0009");
    const invalidDisabled = await percentages.getByRole("button", { name: "Add expense", exact: true }).isDisabled();
    console.log(`Percentage total 100.0009: disabled=${invalidDisabled}, expected=true`);
    if (!invalidDisabled) failures.push("percentage preview accepts a total above 100");
    await percentages.getByLabel("Percentages for Audit 3", { exact: true }).fill("50");
    assert.equal(await percentages.getByRole("button", { name: "Add expense", exact: true }).isEnabled(), true);
    await percentages.getByRole("button", { name: "Cancel", exact: true }).click();
    for (const [method, first, second] of [["Exact amounts", "6.67", "3,33"], ["Shares", "2", "1"]]) {
      await page.getByRole("button", { name: "Add expense", exact: true }).click();
      const split = page.getByRole("dialog", { name: "Add expense", exact: true });
      await split.locator("#expense-amount").fill("10");
      await split.getByLabel("Description", { exact: true }).fill(`Audit ${method} preview`);
      await split.getByRole("radio", { name: method, exact: true }).click();
      await split.getByRole("checkbox", { name: "Audit 0", exact: true }).uncheck();
      await split.getByRole("checkbox", { name: "Audit 2", exact: true }).check();
      await split.getByRole("checkbox", { name: "Audit 3", exact: true }).check();
      await split.getByLabel(`${method} for Audit 3`, { exact: true }).fill(first);
      await split.getByLabel(`${method} for Audit 2`, { exact: true }).fill(second);
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
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
