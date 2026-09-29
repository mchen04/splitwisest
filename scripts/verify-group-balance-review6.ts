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
if (!["slow", "expense", "limit"].includes(scenario)) throw new Error("Choose slow, expense, or limit");
const browserBase = "https://127.0.0.1:3216";
const suffix = `gbr6${Date.now().toString(36)}`;

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
    body: { name: `QA Review six ${suffix}`, currency: "USD" } });
  assert(group.res.ok, `group: ${group.text}`);
  const groupId = Number(group.json.id);
  const joined = await request("/api/groups/join", { cookie: jet.cookie, body: { code: group.json.inviteCode } });
  assert(joined.res.ok, `join: ${joined.text}`);
  async function snapshot() {
    const response = await request(`/api/groups/${groupId}`, { cookie: matthew.cookie });
    assert(response.res.ok, `group read: ${response.text}`);
    return (response.json.balances as { userId: number; netCents: number }[])
      .map((row) => [row.userId, row.netCents] as [number, number]).sort((a, b) => a[0] - b[0]);
  }
  try {
    if (scenario === "limit") {
      for (const limit of ["1.5", "NaN", "9007199254740992"]) {
        const response = await request(`/api/groups/${groupId}/group-balances?limit=${limit}`, { cookie: matthew.cookie });
        assert(response.res.status === 400 && String(response.json.error).includes("page limit"),
          `invalid limit ${limit} returned ${response.res.status}: ${response.text}`);
      }
      const valid = await request(`/api/groups/${groupId}/group-balances?limit=1`, { cookie: matthew.cookie });
      assert(valid.res.ok, `valid integer limit: ${valid.text}`);
      console.log("API: fractional and unsafe limits rejected; integer limit accepted");
      return;
    }
    const browser = await webkit.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 850 },
        ignoreHTTPSErrors: true, serviceWorkers: "block" });
      if (scenario === "expense") {
        await context.addInitScript(() => {
          const now = Date.now();
          Date.now = () => now;
        });
        const page = await openGroup(context, matthew.cookie, groupId);
        await page.getByText("No group balances yet").waitFor();
        await page.waitForLoadState("networkidle");
        await page.getByRole("button", { name: "Add group balance" }).click();
        const form = page.getByRole("dialog", { name: "Add group balance" });
        await form.getByLabel("Total to settle").fill("1.00");
        await form.getByLabel("Description").fill("Draft after reimbursement");
        await form.locator('section[aria-label="Who owes"]').getByRole("checkbox", { name: matthew.displayName }).uncheck();
        const preview = form.locator('[aria-label="Balance preview"]');
        await preview.getByText(`${jet.displayName} owes ${matthew.displayName} $1.00`).waitFor();
        let detailReads = 0;
        let syncResponses = 0;
        page.on("request", (req) => {
          if (req.method() === "GET" && new URL(req.url()).pathname === `/api/groups/${groupId}`) detailReads++;
        });
        page.on("response", (response) => {
          if (new URL(response.url()).pathname === "/api/sync" && response.status() === 200) syncResponses++;
        });
        const expense = await request(`/api/groups/${groupId}/expenses`, { cookie: jet.cookie, body: {
          title: "Remote reimbursement", amountCents: 200, currency: "USD",
          date: new Date().toISOString().slice(0, 10), payerId: jet.id,
          categoryId: null, notes: "", splitMethod: "equal", participants: [{ userId: matthew.id }],
        } });
        assert(expense.res.ok, `remote reimbursement: ${expense.text}`);
        const net = new Map(await snapshot());
        assert(net.get(jet.id) === 200 && net.get(matthew.id) === -200, "remote expense did not update group net");
        try {
          await preview.getByText(`${matthew.displayName} owes ${jet.displayName} $1.00`).waitFor({ timeout: 12000 });
        } catch (error) {
          await form.screenshot({ path: `${evidenceDir}/remote-expense-stale.png` });
          console.log(`remote expense preview remained stale after ${syncResponses} sync responses and ${detailReads} detail GETs`);
          throw error;
        }
        assert(syncResponses > 0, "remote expense change had no sync response");
        assert(detailReads > 0, "activity sync reused a fresh cached group detail");
        assert(await form.getByRole("button", { name: "Create group balance" }).isEnabled(), "draft became invalid");
        await preview.getByText(`${matthew.displayName} owes ${jet.displayName} $1.00`).scrollIntoViewIfNeeded();
        await form.screenshot({ path: `${evidenceDir}/remote-expense-preview.png` });
        console.log(`WebKit: frozen cache refreshed group net after remote expense; detail GETs=${detailReads}`);
      }
      if (scenario === "slow") {
        await context.close();
        const initial = await request(`/api/groups/${groupId}/group-balances?limit=50`, { cookie: matthew.cookie });
        assert(initial.res.ok, `initial local list: ${initial.text}`);
        let listed = initial.text;
        const slowContext = await browser.newContext({ viewport: { width: 1280, height: 850 },
          ignoreHTTPSErrors: true, serviceWorkers: "block" });
        let listReads = 0;
        let syncResponses = 0;
        let captured = () => {};
        const firstSnapshot = new Promise<void>((resolve) => { captured = resolve; });
        await slowContext.route(`**/api/groups/${groupId}/group-balances?limit=50`, async (route) => {
          listReads++;
          if (listReads === 1) console.log("slow list: first request started");
          const body = listed;
          if (listReads === 1) {
            captured();
            console.log("slow list: first response captured before remote write");
          }
          await new Promise((resolve) => setTimeout(resolve, 5200));
          await route.fulfill({ status: 200, contentType: "application/json", body });
        });
        const [name, value] = matthew.cookie.split("=");
        await slowContext.addCookies([{ name, value, url: browserBase }]);
        const page = await slowContext.newPage();
        page.on("response", (response) => {
          if (new URL(response.url()).pathname === "/api/sync" && response.status() === 200) syncResponses++;
        });
        await page.goto(`${browserBase}/groups/${groupId}`, { waitUntil: "domcontentloaded" });
        console.log("slow list: group navigation finished");
        await page.locator('[data-group-tab="balances"]:visible').click();
        console.log("slow list: balances tab opened");
        await Promise.race([firstSnapshot, new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("first slow list response did not start")), 12000))]);
        const added = await request(`/api/groups/${groupId}/group-balances`, { cookie: jet.cookie, body: {
          title: "Remote slow balance", amountCents: 100,
          owes: { method: "equal", participants: [{ userId: jet.id }] },
          receives: { method: "equal", participants: [{ userId: matthew.id }] },
          expectedBalances: await snapshot(),
        } });
        assert(added.res.ok, `remote group balance: ${added.text}`);
        const fresh = await request(`/api/groups/${groupId}/group-balances?limit=50`, { cookie: matthew.cookie });
        assert(fresh.res.ok, `fresh local list: ${fresh.text}`);
        listed = fresh.text;
        try {
          await page.getByRole("button", { name: "Remote slow balance", exact: true }).waitFor({ timeout: 19000 });
        } catch (error) {
          await page.screenshot({ path: `${evidenceDir}/slow-list-stuck.png` });
          console.log(`slow list stayed empty after ${syncResponses} sync responses and ${listReads} list GETs`);
          throw error;
        }
        await page.getByText("Owed $1.00").waitFor({ timeout: 10000 });
        assert(syncResponses >= 2, `only ${syncResponses} sync responses; slow-poll overlap was not exercised`);
        assert(listReads <= 4, `polling launched ${listReads} overlapping list reads`);
        await page.screenshot({ path: `${evidenceDir}/slow-list-settled.png` });
        console.log(`WebKit: slow list loaded remote write after ${syncResponses} sync responses and ${listReads} list GETs`);
        await slowContext.close();
      } else {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    await cleanupQaUsers(suffix);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
