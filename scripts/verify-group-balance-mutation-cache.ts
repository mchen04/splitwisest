import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { webkit, type Page, type Route } from "playwright-core";
import { assert, cleanupQaUsers, request, signup } from "./qa-support";

if (process.env.NEON_LOCAL_PROXY !== "http://127.0.0.1:4445/sql" ||
  !process.env.DATABASE_URL?.includes("@db.localtest.me:5432/splitwisest") ||
  process.env.SPLITWISEST_BASE_URL !== "http://127.0.0.1:3217") {
  throw new Error("This check requires the isolated local database and app");
}
const evidenceDir = process.env.GROUP_BALANCE_EVIDENCE_DIR;
if (!evidenceDir || evidenceDir.startsWith(process.cwd())) throw new Error("Evidence must be outside the checkout");
const browserBase = "https://127.0.0.1:3216";
const suffix = `gbcache${Date.now().toString(36)}`;
const password = randomUUID();

async function login(page: Page, username: string) {
  await page.goto(`${browserBase}/login`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

async function main() {
  await mkdir(evidenceDir!, { recursive: true });
  const matthew = await signup("matthew", suffix, password);
  const jet = await signup("jet", suffix, password);
  const group = await request("/api/groups", { cookie: matthew.cookie,
    body: { name: `QA Cache balance ${suffix}`, currency: "USD" } });
  assert(group.res.ok, `group: ${group.text}`);
  const groupId = Number(group.json.id);
  const joined = await request("/api/groups/join", { cookie: jet.cookie, body: { code: group.json.inviteCode } });
  assert(joined.res.ok, `join: ${joined.text}`);
  const other = await request("/api/groups", { cookie: matthew.cookie,
    body: { name: `QA Cache other ${suffix}`, currency: "USD" } });
  assert(other.res.ok, `other group: ${other.text}`);
  const otherId = Number(other.json.id);
  const browser = await webkit.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, ignoreHTTPSErrors: true, serviceWorkers: "block" });
    const page = await context.newPage();
    await login(page, matthew.username);
    await page.goto(`${browserBase}/groups/${groupId}`);
    await page.locator('[data-group-tab="balances"]:visible').click();
    await page.getByText("No group balances yet").waitFor();
    await page.waitForResponse((response) => response.url().endsWith("/api/sync"));
    await page.waitForResponse((response) => response.url().endsWith("/api/sync"));

    async function checkMutation(stage: string, mutate: () => Promise<void>, check: () => Promise<void>) {
      await page.waitForTimeout(1650);
      const seen = new Set<string>();
      const fresh = { list: 0, detail: 0 };
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let capturedResolve = () => {};
      const captured = new Promise<void>((resolve) => { capturedResolve = resolve; });
      let readyCount = 0;
      const handler = async (route: Route) => {
        const url = new URL(route.request().url());
        const key: "detail" | "list" | null = url.pathname === `/api/groups/${groupId}` ? "detail" :
          url.pathname === `/api/groups/${groupId}/group-balances` && url.searchParams.get("limit") === "50" &&
          !url.searchParams.has("before") ? "list" : null;
        if (!key || route.request().method() !== "GET") return route.continue();
        if (seen.has(key)) {
          fresh[key]++;
          return route.continue();
        }
        seen.add(key);
        const oldResponse = await route.fetch();
        if (++readyCount === 2) capturedResolve();
        await gate;
        await route.fulfill({ response: oldResponse });
      };
      await page.route(`**/api/groups/${groupId}**`, handler);
      try {
        const changed = await request(`/api/groups/${otherId}`, { cookie: matthew.cookie,
          method: "PATCH", body: { name: `QA Cache other ${stage} ${suffix}` } });
        assert(changed.res.ok, `activity trigger ${stage}: ${changed.text}`);
        await Promise.race([captured, new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`old list/detail reads did not start for ${stage}`)), 12000))]);
        await page.evaluate(() => {
          const original = Date.now;
          const frozen = original();
          (window as Window & { restoreQaTime?: () => void }).restoreQaTime = () => { Date.now = original; };
          Date.now = () => frozen;
        });
        await mutate();
        await page.waitForTimeout(500);
        console.log(`${stage}: fresh list GETs=${fresh.list}, fresh detail GETs=${fresh.detail}`);
        assert(fresh.list > 0 && fresh.detail > 0,
          `${stage} reused a pre-mutation list or group-detail request after a successful write`);
      } finally {
        release();
        await page.evaluate(() => (window as Window & { restoreQaTime?: () => void }).restoreQaTime?.());
        await page.unroute(`**/api/groups/${groupId}**`, handler);
      }
      await check();
      await page.screenshot({ path: `${evidenceDir}/${stage}-fresh.png` });
    }

    await checkMutation("create", async () => {
      await page.getByRole("button", { name: "Add group balance" }).click();
      const form = page.getByRole("dialog", { name: "Add group balance" });
      await form.getByLabel("Total to settle").fill("1.00");
      await form.getByLabel("Description").fill("Cached balance");
      await form.locator('section[aria-label="Who owes"]').getByRole("checkbox", { name: matthew.displayName }).uncheck();
      await form.getByRole("button", { name: "Create group balance" }).click();
      await form.waitFor({ state: "hidden" });
    }, async () => {
      await page.getByRole("button", { name: "Cached balance", exact: true }).waitFor();
      await page.getByText("Owed $1.00").waitFor();
    });

    await page.getByRole("button", { name: "Cached balance", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit group balance" });
    await checkMutation("edit", async () => {
      await edit.getByLabel("Total to settle").fill("2.00");
      await edit.getByLabel("Description").fill("Cached balance edited");
      await edit.getByRole("button", { name: "Save group balance" }).click();
      await edit.waitFor({ state: "hidden" });
    }, async () => {
      await page.getByRole("button", { name: "Cached balance edited", exact: true }).waitFor();
      await page.getByText("Owed $2.00").waitFor();
    });

    await checkMutation("delete", async () => {
      await page.getByRole("button", { name: "Delete Cached balance edited" }).click();
      // Deletion confirms in the app's own dialog, not the browser's.
      await page.getByRole("dialog", { name: "Delete group balance?" })
        .getByRole("button", { name: "Delete group balance" }).click();
    }, async () => {
      await page.getByText("No group balances yet").waitFor();
      await page.getByText("All settled up").first().waitFor();
    });
    await context.close();
    console.log("local create, edit, and delete forced fresh list and group-detail reads across held stale responses");
  } finally {
    await browser.close();
  }
}

main().finally(() => cleanupQaUsers(suffix)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
