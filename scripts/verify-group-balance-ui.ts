import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { webkit, type Page } from "playwright-core";
import { assert, cleanupQaUsers, request, signup } from "./qa-support";

if (process.env.NEON_LOCAL_PROXY !== "http://127.0.0.1:4445/sql" ||
  !process.env.DATABASE_URL?.includes("@db.localtest.me:5432/splitwisest") ||
  process.env.SPLITWISEST_BASE_URL !== "http://127.0.0.1:3217") {
  throw new Error("This check requires the isolated local database and app");
}
const evidenceDir = process.env.GROUP_BALANCE_EVIDENCE_DIR;
if (!evidenceDir || evidenceDir.startsWith(process.cwd())) throw new Error("Evidence must be outside the checkout");
const browserBase = "https://127.0.0.1:3216";
const suffix = `gbui${Date.now().toString(36)}`;
const password = randomUUID();

async function login(page: Page, username: string) {
  await page.goto(`${browserBase}/login`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  const authResponse = page.waitForResponse((res) => res.url().endsWith("/api/auth/login"));
  await page.getByRole("button", { name: "Log in" }).click();
  const auth = await authResponse;
  assert(auth.ok(), `browser login failed: ${auth.status()} ${await auth.text()}`);
  await page.waitForURL((url) => url.pathname === "/");
  const me = await page.request.get(`${browserBase}/api/me`);
  assert(me.ok(), `browser session did not persist: ${me.status()}`);
}

async function main() {
  await mkdir(evidenceDir!, { recursive: true });
  const matthew = await signup("matthew", suffix, password);
  const michael = await signup("michael", suffix, password);
  const jet = await signup("jet", suffix, password);
  const other = await signup("other", suffix, password);
  const created = await request("/api/groups", { cookie: matthew.cookie,
    body: { name: `QA Group balance UI ${suffix}`, currency: "USD" } });
  assert(created.res.ok, `group: ${created.text}`);
  const groupId = Number(created.json.id);
  for (const member of [michael, jet, other]) {
    const joined = await request("/api/groups/join", { cookie: member.cookie, body: { code: created.json.inviteCode } });
    assert(joined.res.ok, `join: ${joined.text}`);
  }
  const browser = await webkit.launch({ headless: true });
  try {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 850 }, ignoreHTTPSErrors: true, serviceWorkers: "block" });
    const page = await desktop.newPage();
    await login(page, matthew.username);
    await page.goto(`${browserBase}/groups/${groupId}`);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `${evidenceDir}/desktop-before-tab.png` });
    console.log("desktop group URL", page.url());
    await page.locator('[data-group-tab="balances"]:visible').click();
    await page.getByRole("button", { name: "Add group balance" }).click();
    const modal = page.getByRole("dialog", { name: "Add group balance" });
    await modal.getByLabel("Total to settle").fill("-5");
    assert(await modal.getByRole("button", { name: "Create group balance" }).isDisabled(), "negative total was allowed");
    await modal.getByLabel("Total to settle").fill("1.001");
    assert(await modal.getByRole("button", { name: "Create group balance" }).isDisabled(), "fractional cent total was allowed");
    await modal.getByLabel("Total to settle").fill("120.00");
    await modal.getByLabel("Description").fill("Shared obligations");
    const owes = modal.locator('section[aria-label="Who owes"]');
    const receives = modal.locator('section[aria-label="Who should receive"]');
    await owes.getByRole("checkbox", { name: other.displayName }).uncheck();
    await receives.getByRole("checkbox", { name: matthew.displayName }).uncheck();
    assert(await modal.getByRole("button", { name: "Create group balance" }).isDisabled(), "missing recipient was allowed");
    await receives.getByRole("checkbox", { name: matthew.displayName }).check();
    await receives.getByRole("checkbox", { name: michael.displayName }).check();
    await receives.getByRole("radio", { name: "Exact amounts" }).click();
    await receives.getByRole("textbox", { name: `Exact amounts for ${matthew.displayName}` }).fill("80.00");
    await receives.getByRole("textbox", { name: `Exact amounts for ${michael.displayName}` }).fill("39.99");
    assert(await modal.getByRole("button", { name: "Create group balance" }).isDisabled(), "mismatch was allowed");
    await receives.getByRole("textbox", { name: `Exact amounts for ${michael.displayName}` }).fill("40.00");
    await modal.getByText(`${matthew.displayName}`).first().waitFor();
    assert((await modal.getByText("receives $40.00").count()) > 0, "overlap net preview missing");
    assert((await modal.locator('[aria-label="Balance preview"]').getByText(other.displayName).count()) === 0,
      "unselected person appears in preview");
    await page.waitForTimeout(400);
    await modal.screenshot({ path: `${evidenceDir}/desktop-form.png` });
    await modal.locator('[aria-label="Balance preview"]').scrollIntoViewIfNeeded();
    await modal.screenshot({ path: `${evidenceDir}/desktop-preview.png` });
    await modal.getByRole("button", { name: "Create group balance" }).click();
    await modal.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Shared obligations", exact: true }).waitFor();
    await page.screenshot({ path: `${evidenceDir}/desktop-saved.png`, fullPage: true });
    const overview = await request(`/api/groups/${groupId}`, { cookie: matthew.cookie });
    assert(overview.res.ok, `overview: ${overview.text}`);
    const nets = new Map((overview.json.balances as { userId: number; netCents: number }[])
      .map((row) => [row.userId, row.netCents]));
    assert(nets.get(matthew.id) === 4000 && nets.get(michael.id) === 0 && nets.get(jet.id) === -4000 &&
      nets.get(other.id) === 0, "browser-created balance totals wrong");

    await page.getByRole("button", { name: "Shared obligations", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit group balance" });
    assert(await edit.getByLabel("Total to settle").inputValue() === "120.00", "total did not reopen");
    assert(await edit.locator('section[aria-label="Who should receive"]').getByRole("radio", { name: "Exact amounts" }).getAttribute("aria-checked") === "true", "method did not reopen");
    const editOwes = edit.locator('section[aria-label="Who owes"]');
    await editOwes.getByRole("checkbox", { name: jet.displayName }).uncheck();
    await editOwes.getByRole("checkbox", { name: other.displayName }).check();
    const deltaPreview = edit.locator('[aria-label="Balance preview"]');
    assert(await deltaPreview.locator("li").filter({ hasText: jet.displayName }).getByText("receives $40.00").count() === 1,
      "removed debtor is missing the edit delta");
    assert(await deltaPreview.locator("li").filter({ hasText: other.displayName }).getByText("owes $40.00").count() === 1,
      "new debtor has the wrong edit delta");
    assert(await deltaPreview.locator("li").filter({ hasText: matthew.displayName }).getByText("no net change").count() === 1,
      "unchanged recipient appears to gain balance again");
    await deltaPreview.scrollIntoViewIfNeeded();
    await edit.screenshot({ path: `${evidenceDir}/review-edit-delta.png` });
    await editOwes.getByRole("checkbox", { name: other.displayName }).uncheck();
    await editOwes.getByRole("checkbox", { name: jet.displayName }).check();
    await edit.getByLabel("Total to settle").fill("0.01");
    await edit.locator('section[aria-label="Who owes"]').getByRole("radio", { name: "Shares", exact: true }).click();
    for (const member of [matthew, michael, jet]) {
      await edit.locator('section[aria-label="Who owes"]').getByRole("textbox", { name: `Shares for ${member.displayName}` }).fill("1");
    }
    await edit.locator('section[aria-label="Who should receive"]').getByRole("radio", { name: "Percentages" }).click();
    for (const member of [matthew, michael]) {
      await edit.locator('section[aria-label="Who should receive"]').getByRole("textbox", { name: `Percentages for ${member.displayName}` }).fill("50");
    }
    await edit.screenshot({ path: `${evidenceDir}/desktop-edit.png` });
    let injected = false;
    const editRoute = /\/api\/group-balances\/\d+$/;
    await page.route(editRoute, async (route) => {
      if (!injected && route.request().method() === "PATCH") {
        injected = true;
        const current = await request(`/api/groups/${groupId}`, { cookie: michael.cookie });
        assert(current.res.ok, `concurrent browser overview: ${current.text}`);
        const expectedBalances = (current.json.balances as { userId: number; netCents: number }[])
          .map((b) => [b.userId, b.netCents] as [number, number]).sort((a, b) => a[0] - b[0]);
        const changed = await request(`/api/groups/${groupId}/group-balances`, { cookie: michael.cookie,
          body: { title: "Concurrent browser change", amountCents: 100,
            owes: { method: "equal", participants: [{ userId: jet.id }] },
            receives: { method: "equal", participants: [{ userId: matthew.id }] }, expectedBalances,
          } });
        assert(changed.res.ok, `concurrent browser change: ${changed.text}`);
      }
      await route.continue();
    });
    assert(await edit.getByRole("button", { name: "Save group balance" }).isEnabled(), "edited split was invalid before stale-save test");
    const staleResponse = page.waitForResponse((res) => res.url().includes("/api/group-balances/") && res.request().method() === "PATCH");
    await edit.getByRole("button", { name: "Save group balance" }).click();
    const staleSave = await staleResponse;
    assert(injected && staleSave.status() === 400, "concurrent change did not reject the stale browser save");
    await edit.getByText("Group balances changed. Refresh and try again").waitFor();
    assert(await edit.isVisible(), "stale preview closed the edit form");
    await page.unroute(editRoute);
    await edit.getByText(`${jet.displayName} owes ${matthew.displayName} $1.00`).waitFor();
    await edit.locator('[aria-label="Balance preview"]').scrollIntoViewIfNeeded();
    await edit.screenshot({ path: `${evidenceDir}/review-refreshed-preview.png` });
    await edit.getByRole("button", { name: "Save group balance" }).click();
    await edit.waitFor({ state: "hidden" });
    await page.reload();
    await page.locator('[data-group-tab="balances"]:visible').click();
    await page.getByRole("button", { name: "Shared obligations", exact: true }).click();
    const reopened = page.getByRole("dialog", { name: "Edit group balance" });
    assert(await reopened.getByLabel("Total to settle").inputValue() === "0.01", "edited total lost after reload");
    assert(await reopened.locator('section[aria-label="Who owes"]').getByRole("radio", { name: "Shares", exact: true }).getAttribute("aria-checked") === "true", "edited method lost");
    await reopened.getByRole("button", { name: "Cancel" }).click();

    for (const width of [320, 390, 393]) {
      const mobile = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, deviceScaleFactor: 3, ignoreHTTPSErrors: true,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1" });
      await mobile.addInitScript(() => { Object.defineProperty(navigator, "standalone", { value: true }); });
      const phone = await mobile.newPage();
      await login(phone, matthew.username);
      await phone.goto(`${browserBase}/groups/${groupId}`);
      await phone.locator('[data-group-tab="balances"]:visible').click();
      await phone.getByRole("button", { name: "Add group balance" }).click();
      const mobileModal = phone.getByRole("dialog", { name: "Add group balance" });
      await mobileModal.getByLabel("Total to settle").fill("101.00");
      await mobileModal.getByLabel("Description").fill("Phone preview");
      await phone.waitForTimeout(400);
      await mobileModal.getByLabel("Total to settle").scrollIntoViewIfNeeded();
      const suffix = width === 390 ? "" : `-${width}`;
      await mobileModal.screenshot({ path: `${evidenceDir}/mobile-form${suffix}.png` });
      await mobileModal.locator('[aria-label="Balance preview"]').scrollIntoViewIfNeeded();
      await mobileModal.screenshot({ path: `${evidenceDir}/mobile-preview${suffix}.png` });
      await mobileModal.getByRole("button", { name: "Cancel" }).click();
      await phone.screenshot({ path: `${evidenceDir}/mobile-balances${suffix}.png`, fullPage: true });
      await mobile.close();
    }

    async function currentSnapshot(): Promise<[number, number][]> {
      const current = await request(`/api/groups/${groupId}`, { cookie: matthew.cookie });
      assert(current.res.ok, `paging overview: ${current.text}`);
      return (current.json.balances as { userId: number; netCents: number }[])
        .map((b) => [b.userId, b.netCents] as [number, number]).sort((a, b) => a[0] - b[0]);
    }
    for (let n = 0; n < 51; n++) {
      const added = await request(`/api/groups/${groupId}/group-balances`, { cookie: matthew.cookie,
        body: { title: `Page ${n}`, amountCents: 1,
          owes: { method: "equal", participants: [{ userId: jet.id }] },
          receives: { method: "equal", participants: [{ userId: matthew.id }] },
          expectedBalances: await currentSnapshot(),
        } });
      assert(added.res.ok, `paging fixture ${n}: ${added.text}`);
    }
    await page.reload();
    await page.locator('[data-group-tab="balances"]:visible').click();
    await page.getByRole("button", { name: "Load more" }).click();
    await page.getByRole("button", { name: "Page 0", exact: true }).waitFor();
    const shifted = await request(`/api/groups/${groupId}/group-balances`, { cookie: michael.cookie,
      body: { title: "Page 51", amountCents: 1,
        owes: { method: "equal", participants: [{ userId: jet.id }] },
        receives: { method: "equal", participants: [{ userId: matthew.id }] },
        expectedBalances: await currentSnapshot(),
      } });
    assert(shifted.res.ok, `shifted first page: ${shifted.text}`);
    await page.getByRole("button", { name: "Page 51", exact: true }).waitFor({ timeout: 15000 });
    assert(await page.getByRole("button", { name: "Page 1", exact: true }).count() === 0,
      "old appended page stayed visible after the first page shifted");
    await page.getByRole("button", { name: "Page 51", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidenceDir}/review-pagination-reset.png` });
    await page.getByRole("button", { name: "Load more" }).click();
    await page.getByRole("button", { name: "Page 1", exact: true }).waitFor();
    assert(await page.getByRole("button", { name: "Page 0", exact: true }).count() === 1 &&
      await page.getByRole("button", { name: "Page 1", exact: true }).count() === 1,
      "paging sync omitted or duplicated a balance");
    await page.screenshot({ path: `${evidenceDir}/review-pagination-after-sync.png`, fullPage: true });
    await desktop.close();
    console.log("WebKit desktop/mobile: edit delta, stale-preview refresh, saved balances, and synced cursor pagination passed");
  } finally {
    await browser.close();
  }
}

main().finally(() => cleanupQaUsers(suffix)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
