import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { webkit, type BrowserContext } from "playwright-core";
import { assert, cleanupQaUsers, request, signup, sql } from "./qa-support";

if (process.env.NEON_LOCAL_PROXY !== "http://127.0.0.1:4445/sql" ||
  !process.env.DATABASE_URL?.includes("@db.localtest.me:5432/splitwisest") ||
  process.env.SPLITWISEST_BASE_URL !== "http://127.0.0.1:3217") {
  throw new Error("This check requires the isolated local database and app");
}
const evidenceDir = process.env.GROUP_BALANCE_EVIDENCE_DIR;
if (!evidenceDir || evidenceDir.startsWith(process.cwd())) throw new Error("Evidence must be outside the checkout");
const browserBase = "https://127.0.0.1:3216";
const suffix = `gbr5${Date.now().toString(36)}`;

async function holdGroupLock(groupId: number) {
  const child = spawn("docker", ["exec", "-i", "sw-group-balances-pg", "psql", "-X", "-qAt", "-U", "localtest", "-d", "splitwisest"]);
  const ready = new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Local advisory lock did not start")), 5000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("locked")) { clearTimeout(timer); resolve(); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Local lock session exited: ${code}`)); });
  });
  child.stdin.write(`BEGIN; SELECT pg_advisory_xact_lock(${groupId}); SELECT 'locked';\n`);
  await ready;
  return child;
}

async function waitForBlockedWrite() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const rows = await sql`SELECT count(*)::int AS blocked FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted`;
    if (Number(rows[0].blocked) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The edit did not reach the held local group lock");
}

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
  const [matthew, michael, jet, other] = await Promise.all([
    signup("matthew", suffix, password), signup("michael", suffix, password),
    signup("jet", suffix, password), signup("other", suffix, password),
  ]);
  const group = await request("/api/groups", { cookie: matthew.cookie,
    body: { name: `QA Review five ${suffix}`, currency: "USD" } });
  assert(group.res.ok, `group: ${group.text}`);
  const groupId = Number(group.json.id);
  for (const member of [michael, jet, other]) {
    const joined = await request("/api/groups/join", { cookie: member.cookie, body: { code: group.json.inviteCode } });
    assert(joined.res.ok, `join: ${joined.text}`);
  }
  async function snapshot() {
    const response = await request(`/api/groups/${groupId}`, { cookie: matthew.cookie });
    assert(response.res.ok, `group read: ${response.text}`);
    return (response.json.balances as { userId: number; netCents: number }[])
      .map((row) => [row.userId, row.netCents] as [number, number]).sort((a, b) => a[0] - b[0]);
  }
  async function add(title: string, amountCents: number, owes: object, receives: object) {
    const response = await request(`/api/groups/${groupId}/group-balances`, { cookie: matthew.cookie,
      body: { clientRequestId: crypto.randomUUID(), title, amountCents, owes, receives, expectedBalances: await snapshot() } });
    assert(response.res.ok, `add: ${response.text}`);
    return Number(response.json.id);
  }
  async function read(id: number) {
    const response = await request(`/api/group-balances/${id}`, { cookie: matthew.cookie });
    assert(response.res.ok, `read: ${response.text}`);
    return response.json.balance as { updatedAt: string; receives: { participants: { userId: number; shareCents: number }[] } };
  }
  async function remove(id: number, updatedAt: string) {
    const response = await request(`/api/group-balances/${id}?expectedUpdatedAt=${encodeURIComponent(updatedAt)}`,
      { cookie: michael.cookie, method: "DELETE" });
    assert(response.res.ok, `delete: ${response.text}`);
  }
  const owesOther = { method: "equal", participants: [{ userId: other.id }] };
  const receivesMatthew = { method: "equal", participants: [{ userId: matthew.id }] };
  try {
    const exactId = await add("Exact percent", 99_999_999, owesOther, { method: "percentage", participants: [
      { userId: matthew.id, value: 37.1454 }, { userId: michael.id, value: 25.709201 },
      { userId: jet.id, value: 37.145399 },
    ] });
    const exact = await read(exactId);
    const awarded = new Map(exact.receives.participants.map((row) => [row.userId, row.shareCents]));
    assert(awarded.get(matthew.id) === 37_145_399 && awarded.get(michael.id) === 25_709_201 &&
      awarded.get(jet.id) === 37_145_399, "API stored the wrong exact remainders");
    const net = new Map(await snapshot());
    assert(net.get(matthew.id) === 37_145_399 && net.get(michael.id) === 25_709_201 &&
      net.get(jet.id) === 37_145_399 && net.get(other.id) === -99_999_999, "group net differs from exact allocation");
    await remove(exactId, exact.updatedAt);
    const missing = await request(`/api/group-balances/${exactId}`, { cookie: matthew.cookie, method: "PATCH",
      body: { title: "Too late", amountCents: 99_999_999, owes: owesOther, receives: receivesMatthew,
        expectedUpdatedAt: exact.updatedAt, expectedBalances: await snapshot() } });
    assert(missing.res.status === 400 && String(missing.json.error).includes("Close and reopen"),
      `deleted-before-request edit did not return a terminal conflict: ${missing.res.status} ${missing.text}`);
    console.log("API: exact percent cents and deleted-before-request conflict passed");

    const raceId = await add("Concurrent removal", 100, owesOther, receivesMatthew);
    const race = await read(raceId);
    let lock: ChildProcessWithoutNullStreams | null = null;
    try {
      lock = await holdGroupLock(groupId);
      const pending = request(`/api/group-balances/${raceId}`, { cookie: matthew.cookie, method: "PATCH",
        body: { title: "Too late in lock", amountCents: 100, owes: owesOther, receives: receivesMatthew,
          expectedUpdatedAt: race.updatedAt, expectedBalances: await snapshot() } });
      await waitForBlockedWrite();
      await sql`DELETE FROM group_obligations WHERE id = ${raceId}`;
      lock.stdin.write("COMMIT;\n");
      const raced = await pending;
      assert(raced.res.status === 400 && String(raced.json.error).includes("Close and reopen"),
        `concurrent deletion did not return a terminal conflict: ${raced.res.status} ${raced.text}`);
      console.log("API: deletion after initial read and before locked update passed");
    } finally {
      lock?.stdin.end("COMMIT;\n");
    }

    const browser = await webkit.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 850 },
        ignoreHTTPSErrors: true, serviceWorkers: "block" });
      const page = await openGroup(context, matthew.cookie, groupId);
      await page.getByRole("button", { name: "Add group balance" }).click();
      const draft = page.getByRole("dialog", { name: "Add group balance" });
      await draft.getByLabel("Total to settle").fill("999999.99");
      await draft.getByLabel("Description").fill("Exact preview");
      const owed = draft.locator('section[aria-label="Who owes"]');
      for (const member of [matthew, michael, jet]) {
        await owed.getByRole("checkbox", { name: member.displayName }).uncheck();
      }
      const received = draft.locator('section[aria-label="Who should receive"]');
      for (const member of [michael, jet]) await received.getByRole("checkbox", { name: member.displayName }).check();
      await received.getByRole("radio", { name: "Percentages" }).click();
      for (const [member, percent] of [[matthew, "37.1454"], [michael, "25.709201"], [jet, "37.145399"]] as const) {
        await received.getByRole("textbox", { name: `Percentages for ${member.displayName}` }).fill(percent);
      }
      const preview = draft.locator('[aria-label="Balance preview"]');
      for (const [member, cents] of [[matthew, "$371,453.99"], [michael, "$257,092.01"], [jet, "$371,453.99"]] as const) {
        assert(await preview.locator("li").filter({ hasText: member.displayName }).getByText(`receives ${cents}`).count() === 1,
          `preview awarded the wrong cents to ${member.displayName}`);
      }
      await preview.scrollIntoViewIfNeeded();
      await draft.screenshot({ path: `${evidenceDir}/exact-percent-preview.png` });
      await draft.getByRole("button", { name: "Cancel" }).click();
      console.log("WebKit: preview matches API exact remainders");
      await context.close();

      const editId = await add("Deleted while editing", 100, owesOther, receivesMatthew);
      const editRecord = await read(editId);
      const errorContext = await browser.newContext({ viewport: { width: 1280, height: 850 },
        ignoreHTTPSErrors: true, serviceWorkers: "block" });
      let failList = true;
      await errorContext.route(`**/api/groups/${groupId}/group-balances?limit=50`, async (route) => {
        if (failList) await route.fulfill({ status: 503, contentType: "application/json",
          body: JSON.stringify({ error: "Temporary list failure" }) });
        else await route.continue();
      });
      await errorContext.route("**/api/sync", (route) => route.fulfill({ status: 503, body: "{}" }));
      const errorPage = await openGroup(errorContext, matthew.cookie, groupId);
      await errorPage.getByRole("alert").getByText("Temporary list failure").waitFor();
      const listCard = errorPage.getByRole("heading", { name: "Group balances" }).locator("..").locator("..");
      assert(await listCard.locator('.skeleton').count() === 0, "failed list still looks like loading");
      await errorPage.screenshot({ path: `${evidenceDir}/list-error.png` });
      failList = false;
      await errorPage.getByRole("alert").getByRole("button", { name: "Try again" }).click();
      await errorPage.getByRole("button", { name: "Deleted while editing", exact: true }).waitFor();
      await errorPage.screenshot({ path: `${evidenceDir}/list-retried.png` });
      console.log("WebKit: failed first list read shows error and retry loads rows");

      await errorPage.getByRole("button", { name: "Deleted while editing", exact: true }).click();
      const edit = errorPage.getByRole("dialog", { name: "Edit group balance" });
      await edit.locator('[aria-label="Balance preview"]').waitFor();
      await remove(editId, editRecord.updatedAt);
      const patchResponse = errorPage.waitForResponse((response) => response.url().endsWith(`/api/group-balances/${editId}`) &&
        response.request().method() === "PATCH");
      await edit.getByRole("button", { name: "Save group balance" }).click();
      assert((await patchResponse).status() === 400, "deleted edit did not return conflict to browser");
      await edit.getByText("This group balance changed. Close and reopen it before editing").waitFor();
      assert(await edit.locator('[aria-label="Balance preview"]').count() === 0, "deleted edit kept stale preview");
      assert(await edit.getByRole("button", { name: "Save group balance" }).isDisabled(), "deleted edit left Save enabled");
      await errorPage.getByText("No group balances yet").waitFor();
      await errorPage.getByText("All settled up").first().waitFor();
      await edit.screenshot({ path: `${evidenceDir}/deleted-edit-conflict.png` });
      await edit.getByRole("button", { name: "Cancel" }).click();
      await errorPage.screenshot({ path: `${evidenceDir}/deleted-edit-refreshed.png` });
      console.log("WebKit: missing edit locks form and refreshes list and group net");
      await errorContext.close();
    } finally {
      await browser.close();
    }
  } finally {
    await cleanupQaUsers(suffix);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
