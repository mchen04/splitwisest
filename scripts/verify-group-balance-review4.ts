import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { webkit, type BrowserContext } from "playwright-core";
import { assert, cleanupQaUsers, request, signup } from "./qa-support";

if (process.env.NEON_LOCAL_PROXY !== "http://127.0.0.1:4445/sql" ||
  !process.env.DATABASE_URL?.includes("@db.localtest.me:5432/splitwisest") ||
  process.env.SPLITWISEST_BASE_URL !== "http://127.0.0.1:3217") {
  throw new Error("This check requires the isolated local database and app");
}
const evidenceDir = process.env.GROUP_BALANCE_EVIDENCE_DIR;
if (!evidenceDir || evidenceDir.startsWith(process.cwd())) throw new Error("Evidence must be outside the checkout");
const scenario = process.argv[2];
if (!["tiny", "pending", "sync"].includes(scenario)) throw new Error("Choose tiny, pending, or sync");
const browserBase = "https://127.0.0.1:3216";
const suffix = `gbr4${Date.now().toString(36)}`;

async function openGroup(context: BrowserContext, cookie: string, groupId: number) {
  const [name, value] = cookie.split("=");
  await context.addCookies([{ name, value, url: browserBase }]);
  const page = await context.newPage();
  await page.goto(`${browserBase}/groups/${groupId}`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-group-tab="balances"]:visible').click();
  return page;
}

async function main() {
  await mkdir(evidenceDir!, { recursive: true });
  const password = randomUUID();
  const matthew = await signup("matthew", suffix, password);
  const jet = await signup("jet", suffix, password);
  const group = await request("/api/groups", { cookie: matthew.cookie,
    body: { name: `QA Review four ${suffix}`, currency: "USD" } });
  assert(group.res.ok, `group: ${group.text}`);
  const groupId = Number(group.json.id);
  const joined = await request("/api/groups/join", { cookie: jet.cookie, body: { code: group.json.inviteCode } });
  assert(joined.res.ok, `join: ${joined.text}`);
  const browser = await webkit.launch({ headless: true });
  try {
    if (scenario === "tiny") {
      const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, ignoreHTTPSErrors: true, serviceWorkers: "block" });
      const page = await openGroup(context, matthew.cookie, groupId);
      await page.getByRole("button", { name: "Add group balance" }).click();
      const form = page.getByRole("dialog", { name: "Add group balance" });
      await form.getByLabel("Total to settle").fill("1.00");
      await form.getByLabel("Description").fill("Tiny valid shares");
      const owes = form.locator('section[aria-label="Who owes"]');
      await owes.getByRole("radio", { name: "Shares", exact: true }).click();
      const tinyInput = owes.getByRole("textbox", { name: `Shares for ${matthew.displayName}` });
      await tinyInput.fill("0.00000001");
      await owes.getByRole("textbox", { name: `Shares for ${jet.displayName}` }).fill("1");
      assert(await form.getByRole("button", { name: "Create group balance" }).isDisabled(), "excess precision was allowed in the form");
      await form.getByText(`Use at most 7 decimal places for ${matthew.displayName}`).waitFor();
      await tinyInput.fill("0.0000001");
      await form.getByRole("button", { name: "Create group balance" }).click();
      await form.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Tiny valid shares", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "Edit group balance" });
      const tiny = edit.locator('section[aria-label="Who owes"]').getByRole("textbox", { name: `Shares for ${matthew.displayName}` });
      assert(await tiny.inputValue() === "0.0000001", `tiny share reopened as ${await tiny.inputValue()}`);
      await edit.screenshot({ path: `${evidenceDir}/tiny-share-input.png` });
      assert(await edit.getByRole("button", { name: "Save group balance" }).isEnabled(), "tiny share made title edit invalid");
      await edit.getByLabel("Description").fill("Tiny shares renamed");
      await edit.getByRole("button", { name: "Save group balance" }).click();
      await edit.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Tiny shares renamed", exact: true }).waitFor();
      await page.getByRole("button", { name: "Tiny shares renamed", exact: true }).click();
      const savedAgain = page.getByRole("dialog", { name: "Edit group balance" });
      assert(await savedAgain.locator('section[aria-label="Who owes"]')
        .getByRole("textbox", { name: `Shares for ${matthew.displayName}` }).inputValue() === "0.0000001",
      "title edit changed the saved tiny share");
      await savedAgain.getByRole("button", { name: "Cancel" }).click();
      await page.screenshot({ path: `${evidenceDir}/tiny-share-reopened.png` });
      await context.close();
      console.log("tiny share 0.0000001 reopened as decimal and title edit saved");
    }

    if (scenario === "pending") {
      const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, ignoreHTTPSErrors: true, serviceWorkers: "block" });
      const page = await openGroup(context, matthew.cookie, groupId);
      await page.getByRole("button", { name: "Add group balance" }).click();
      const form = page.getByRole("dialog", { name: "Add group balance" });
      await form.getByLabel("Total to settle").fill("1.00");
      await form.getByLabel("Description").fill("Held save");
      await form.locator('section[aria-label="Who owes"]').getByRole("checkbox", { name: matthew.displayName }).uncheck();
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let captured = () => {};
      const started = new Promise<void>((resolve) => { captured = resolve; });
      await page.route(`**/api/groups/${groupId}/group-balances`, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        captured();
        await gate;
        await route.continue();
      });
      const response = page.waitForResponse((res) => res.url().endsWith(`/api/groups/${groupId}/group-balances`) && res.request().method() === "POST");
      await form.getByRole("button", { name: "Create group balance" }).click();
      await started;
      try {
        assert(await form.getByRole("button", { name: "Cancel" }).isDisabled(), "pending save left Cancel enabled");
        assert(await form.getByRole("button", { name: "Close" }).isDisabled(), "pending save left Close enabled");
        await page.keyboard.press("Escape");
        assert(await form.isVisible(), "Escape dismissed a pending save");
        await page.mouse.click(10, 10);
        assert(await form.isVisible(), "backdrop dismissed a pending save");
        await form.screenshot({ path: `${evidenceDir}/pending-save-locked.png` });
      } finally {
        release();
        await response;
      }
      await form.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Add group balance" }).click();
      const later = page.getByRole("dialog", { name: "Add group balance" });
      await later.getByLabel("Description").fill("Later draft");
      assert(await later.getByLabel("Description").inputValue() === "Later draft", "later draft was lost");
      await later.getByRole("button", { name: "Cancel" }).click();
      await context.close();
      console.log("pending save blocked dismissal and later draft stayed open");
    }

    if (scenario === "sync") {
      const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, ignoreHTTPSErrors: true, serviceWorkers: "block" });
      const [name, value] = matthew.cookie.split("=");
      await context.addCookies([{ name, value, url: browserBase }]);
      const page = await context.newPage();
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let captured = () => {};
      const firstStarted = new Promise<void>((resolve) => { captured = resolve; });
      let first = true;
      let baseline: unknown;
      await page.route("**/api/sync", async (route) => {
        if (first) {
          first = false;
          captured();
          await gate;
          const response = await route.fetch();
          baseline = await response.json();
          await route.fulfill({ response });
        } else {
          await route.fulfill({ json: baseline });
        }
      });
      await page.goto(`${browserBase}/groups/${groupId}`, { waitUntil: "domcontentloaded" });
      await page.locator('[data-group-tab="balances"]:visible').click();
      await firstStarted;
      await page.getByText("No group balances yet").waitFor();
      await page.getByText("All settled up").first().waitFor();
      async function addRemote(title: string) {
        const detail = await request(`/api/groups/${groupId}`, { cookie: matthew.cookie });
        assert(detail.res.ok, `snapshot: ${detail.text}`);
        const expectedBalances = (detail.json.balances as { userId: number; netCents: number }[])
          .map((row) => [row.userId, row.netCents] as [number, number]).sort((a, b) => a[0] - b[0]);
        const added = await request(`/api/groups/${groupId}/group-balances`, { cookie: jet.cookie, body: { clientRequestId: crypto.randomUUID(),
          title, amountCents: 100,
          owes: { method: "equal", participants: [{ userId: jet.id }] },
          receives: { method: "equal", participants: [{ userId: matthew.id }] }, expectedBalances,
        } });
        assert(added.res.ok, `remote balance: ${added.text}`);
      }
      await addRemote("Before first sync");
      release();
      await page.getByRole("button", { name: "Before first sync", exact: true }).waitFor({ timeout: 10000 });
      await page.getByText("Owed $1.00").waitFor({ timeout: 10000 });
      await page.screenshot({ path: `${evidenceDir}/first-sync-refresh.png` });
      console.log("first sync response refreshed list and group detail after bootstrap write");
      await addRemote("After fixed global cursor");
      await page.getByRole("button", { name: "After fixed global cursor", exact: true }).waitFor({ timeout: 12000 });
      await page.getByText("Owed $2.00").waitFor({ timeout: 10000 });
      await page.screenshot({ path: `${evidenceDir}/scoped-sync-refresh.png` });
      await context.close();
      console.log("scoped polling refreshed list and detail while global sync cursor stayed fixed");
    }
  } finally {
    await browser.close();
  }
}

main().finally(() => cleanupQaUsers(suffix)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
