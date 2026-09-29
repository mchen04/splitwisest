import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { webkit, type BrowserContext } from "playwright-core";
import { assert, cleanupQaUsers, request, signup, sql } from "./qa-support";

if (process.env.NEON_LOCAL_PROXY !== "http://127.0.0.1:4445/sql" ||
  !process.env.DATABASE_URL?.includes("@db.localtest.me:5432/splitwisest") ||
  process.env.SPLITWISEST_BASE_URL !== "http://127.0.0.1:3217") {
  throw new Error("This check requires the isolated local database and app");
}
const dir = process.env.GROUP_BALANCE_EVIDENCE_DIR;
if (!dir || dir.startsWith(process.cwd())) throw new Error("Evidence must be outside the checkout");
const scenario = process.argv[2];
if (scenario !== "idempotency" && scenario !== "sync" && scenario !== "lost-response") throw new Error("Choose a scenario");
const browserBase = "https://127.0.0.1:3216";
const suffix = `gbr7${Date.now().toString(36)}`;

async function openGroup(context: BrowserContext, cookie: string, groupId: number) {
  const [name, value] = cookie.split("=");
  await context.addCookies([{ name, value, url: browserBase }]);
  const page = await context.newPage();
  await page.goto(`${browserBase}/groups/${groupId}`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-group-tab="balances"]:visible').click();
  await page.getByRole("button", { name: "Add group balance" }).click();
  return page;
}

async function main() {
  await mkdir(dir!, { recursive: true });
  const password = randomUUID();
  const matthew = await signup("matthew", suffix, password);
  const jet = await signup("jet", suffix, password);
  const group = await request("/api/groups", { cookie: matthew.cookie,
    body: { name: `QA Review seven ${suffix}`, currency: "USD" } });
  assert(group.res.ok, `group: ${group.text}`);
  const groupId = Number(group.json.id);
  const joined = await request("/api/groups/join", { cookie: jet.cookie, body: { code: group.json.inviteCode } });
  assert(joined.res.ok, `join: ${joined.text}`);
  const path = `/api/groups/${groupId}/group-balances`;
  async function snapshot() {
    const detail = await request(`/api/groups/${groupId}`, { cookie: matthew.cookie });
    assert(detail.res.ok, `detail: ${detail.text}`);
    return (detail.json.balances as { userId: number; netCents: number }[])
      .map((row) => [row.userId, row.netCents] as [number, number]).sort((a, b) => a[0] - b[0]);
  }
  try {
    if (scenario === "idempotency") {
      const key = randomUUID();
      const body = { clientRequestId: key, title: "Net zero", amountCents: 100,
        owes: { method: "equal", participants: [{ userId: matthew.id }] },
        receives: { method: "equal", participants: [{ userId: matthew.id }] },
        expectedBalances: await snapshot() };
      const first = await request(path, { cookie: matthew.cookie, body });
      assert(first.res.ok, `first create: ${first.text}`);
      const retry = await request(path, { cookie: matthew.cookie, body: {
        ...body, owes: { ...body.owes, participants: [...body.owes.participants].reverse() },
      } });
      assert(retry.res.ok, `retry: ${retry.text}`);
      assert(first.json.id === retry.json.id, `net-zero retry created ${first.json.id} and ${retry.json.id}`);
      const missing = await request(path, { cookie: matthew.cookie, body: { ...body, clientRequestId: undefined } });
      assert(missing.res.status === 400, `missing key accepted: ${missing.text}`);
      const malformed = await request(path, { cookie: matthew.cookie, body: { ...body, clientRequestId: "invalid" } });
      assert(malformed.res.status === 400, `invalid key accepted: ${malformed.text}`);
      const count = await sql`SELECT count(*)::int AS n FROM group_obligations WHERE group_id = ${groupId}`;
      assert(Number(count[0].n) === 1, `net-zero retry produced ${count[0].n} rows`);
      const reuse = await request(path, { cookie: matthew.cookie, body: { ...body, title: "Changed intent" } });
      assert(reuse.res.status === 400 && String(reuse.json.error).includes("different details"),
        `changed payload reused key: ${reuse.text}`);
      const next = { ...body, clientRequestId: randomUUID(), title: "Concurrent net change",
        owes: { method: "equal", participants: [{ userId: jet.id }] } };
      const [left, right] = await Promise.all([
        request(path, { cookie: matthew.cookie, body: next }),
        request(path, { cookie: matthew.cookie, body: next }),
      ]);
      assert(left.res.ok && right.res.ok && left.json.id === right.json.id,
        `concurrent retry differed: ${left.text} / ${right.text}`);
      const contested = { ...body, clientRequestId: randomUUID(),
        title: "Concurrent intent A", expectedBalances: await snapshot() };
      const [a, b] = await Promise.all([
        request(path, { cookie: matthew.cookie, body: contested }),
        request(path, { cookie: matthew.cookie, body: { ...contested, title: "Concurrent intent B" } }),
      ]);
      assert([a.res.status, b.res.status].sort().join(",") === "200,400" &&
        String((a.res.status === 400 ? a : b).json.error).includes("different details"),
        `concurrent key reuse was ambiguous: ${a.text} / ${b.text}`);
      const other = await request(path, { cookie: jet.cookie, body: {
        ...body, title: "Other creator", expectedBalances: await snapshot(),
      } });
      assert(other.res.ok && other.json.id !== first.json.id, `creator scope failed: ${other.text}`);
      const original = await request(`/api/group-balances/${first.json.id}`, { cookie: matthew.cookie });
      assert(original.res.ok, `reopen: ${original.text}`);
      const changed = await request(`/api/group-balances/${first.json.id}`, { cookie: matthew.cookie,
        method: "PATCH", body: { ...body, title: "Edited net zero", expectedUpdatedAt: (original.json.balance as { updatedAt: string }).updatedAt,
          expectedBalances: await snapshot() } });
      assert(changed.res.ok, `edit: ${changed.text}`);
      const afterEdit = await request(path, { cookie: matthew.cookie, body });
      assert(afterEdit.res.ok && afterEdit.json.id === first.json.id, `edited retry lost identity: ${afterEdit.text}`);
      const edited = await request(`/api/group-balances/${first.json.id}`, { cookie: matthew.cookie });
      const deleted = await request(`/api/group-balances/${first.json.id}?expectedUpdatedAt=${encodeURIComponent(String((edited.json.balance as { updatedAt: string }).updatedAt))}`,
        { cookie: matthew.cookie, method: "DELETE" });
      assert(deleted.res.ok, `delete: ${deleted.text}`);
      const afterDelete = await request(path, { cookie: matthew.cookie, body });
      assert(afterDelete.res.status === 400 && String(afterDelete.json.error).includes("deleted"),
        `deleted retry recreated record: ${afterDelete.text}`);
      const receipts = await sql`SELECT count(*)::int AS n FROM group_obligation_create_requests WHERE group_id = ${groupId}`;
      assert(Number(receipts[0].n) === 4, `expected retained create receipts: ${receipts[0].n}`);
      console.log("API: key validation, net-zero retry, concurrent retry, creator scope, payload mismatch, edit and delete passed");
      return;
    }
    const browser = await webkit.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 850 },
        ignoreHTTPSErrors: true, serviceWorkers: "block" });
      await context.addInitScript(() => { const fixed = Date.now(); Date.now = () => fixed; });
      const page = await openGroup(context, matthew.cookie, groupId);
      const form = page.getByRole("dialog", { name: "Add group balance" });
      await form.getByLabel("Total to settle").fill("1.00");
      await form.getByLabel("Description").fill(scenario === "sync" ? "Remote preview" : "Lost response");
      if (scenario === "lost-response") {
        const receives = form.locator('section[aria-label="Who should receive"]');
        await receives.getByRole("checkbox", { name: matthew.displayName }).uncheck();
        await receives.getByRole("checkbox", { name: jet.displayName }).check();
        let attempts = 0;
        const keys: string[] = [];
        await page.route(`**${path}`, async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          attempts++;
          keys.push(String(route.request().postDataJSON().clientRequestId));
          if (attempts === 1 || attempts === 3) {
            const committed = await route.fetch();
            assert(committed.ok(), `first save did not commit: ${committed.status()}`);
            await route.fulfill({ status: 503, contentType: "application/json",
              body: JSON.stringify({ error: "Response lost" }) });
          } else await route.continue();
        });
        await form.getByRole("button", { name: "Create group balance" }).click();
        await form.getByText("Response lost").waitFor();
        await form.screenshot({ path: `${dir}/lost-response-retry.png` });
        await form.getByRole("button", { name: "Create group balance" }).click();
        await form.waitFor({ state: "hidden" });
        assert(attempts === 2 && keys[0] === keys[1] && /^[0-9a-f-]{36}$/.test(keys[0]),
          `same form did not retain key: ${keys.join(",")}`);
        const count = await sql`SELECT count(*)::int AS n FROM group_obligations WHERE group_id = ${groupId}`;
        assert(Number(count[0].n) === 1, `lost response created ${count[0].n} rows`);
        await page.reload({ waitUntil: "networkidle" });
        await page.locator('[data-group-tab="balances"]:visible').click();
        await page.getByRole("button", { name: "Add group balance" }).click();
        const nextForm = page.getByRole("dialog", { name: "Add group balance" });
        await nextForm.getByLabel("Total to settle").fill("1.00");
        await nextForm.getByLabel("Description").fill("New intent before failure");
        await nextForm.locator('section[aria-label="Who should receive"]')
          .getByRole("checkbox", { name: jet.displayName }).check();
        await nextForm.getByRole("button", { name: "Create group balance" }).click();
        await nextForm.getByText("Response lost").waitFor();
        await nextForm.getByLabel("Description").fill("Changed intent after failure");
        await nextForm.getByRole("button", { name: "Create group balance" }).click();
        await nextForm.waitFor({ state: "hidden" });
        const finalCount = await sql`SELECT count(*)::int AS n FROM group_obligations WHERE group_id = ${groupId}`;
        assert(Number(attempts) === 4 && keys[2] !== keys[3] && keys[0] !== keys[2] && Number(finalCount[0].n) === 3,
          `new form or changed intent reused a key: ${keys.join(",")}; rows=${finalCount[0].n}`);
        console.log("WebKit: lost response kept its UUID; a new form and changed intent received new UUIDs");
      } else {
        await form.locator('section[aria-label="Who owes"]').getByRole("checkbox", { name: matthew.displayName }).uncheck();
        const preview = form.locator('[aria-label="Balance preview"]');
        await preview.getByText(`${jet.displayName} owes ${matthew.displayName} $1.00`).waitFor();
        const sync = await request("/api/sync", { cookie: matthew.cookie });
        const beforeList = await request(`${path}?limit=50`, { cookie: matthew.cookie });
        assert(sync.res.ok && beforeList.res.ok, "initial cursors failed");
        let syncResponses = 0;
        let detailReads = 0;
        let release = () => {};
        const pending = new Promise<void>((resolve) => { release = resolve; });
        let firstRead = () => {};
        const started = new Promise<void>((resolve) => { firstRead = resolve; });
        page.on("response", (response) => {
          if (new URL(response.url()).pathname === "/api/sync" && response.ok()) syncResponses++;
        });
        await page.route("**/api/sync", (route) => route.fulfill({ status: 200, contentType: "application/json",
          body: sync.text }));
        await page.route(`**/api/groups/${groupId}`, async (route) => {
          detailReads++;
          if (detailReads === 1) {
            const stale = await route.fetch();
            firstRead();
            await pending;
            await route.fulfill({ response: stale });
          } else await route.continue();
        });
        try {
          await Promise.race([started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no detail poll")), 10000))]);
          const expense = await request(`/api/groups/${groupId}/expenses`, { cookie: jet.cookie, body: {
            title: "Reverse commit expense", amountCents: 200, currency: "USD",
            date: new Date().toISOString().slice(0, 10), payerId: jet.id, categoryId: null, notes: "",
            splitMethod: "equal", participants: [{ userId: matthew.id }],
          } });
          assert(expense.res.ok, `remote expense: ${expense.text}`);
          const afterSync = await request("/api/sync", { cookie: matthew.cookie });
          const afterList = await request(`${path}?limit=50`, { cookie: matthew.cookie });
          assert(afterSync.res.ok && afterList.res.ok && beforeList.json.changeCursor === afterList.json.changeCursor,
            "group balance cursor changed unexpectedly");
          assert((afterSync.json.activityCursor as number) > (sync.json.activityCursor as number),
            "remote expense lacked activity; pinned sync simulates later high-ID commit");
          await new Promise((resolve) => setTimeout(resolve, 8500));
          release();
          await preview.getByText(`${matthew.displayName} owes ${jet.displayName} $1.00`).waitFor({ timeout: 14000 });
          assert(syncResponses >= 2 && detailReads >= 2, `coalesced refresh missing: sync=${syncResponses} detail=${detailReads}`);
          await form.screenshot({ path: `${dir}/same-cursor-slow-preview.png` });
          console.log(`WebKit: pinned sync cursor and unchanged balance cursor refreshed slow preview; sync=${syncResponses}, detail=${detailReads}`);
        } finally { release(); }
      }
      await context.close();
    } finally { await browser.close(); }
  } finally { await cleanupQaUsers(suffix); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
