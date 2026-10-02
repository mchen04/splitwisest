import { spawn } from "node:child_process";
import { assert, cleanupQaUsers, jsonArray, jsonNumber, jsonObject, request, signup, sql } from "./qa-support";

if (process.env.NEON_LOCAL_PROXY !== "http://127.0.0.1:4445/sql" ||
  !process.env.DATABASE_URL?.includes("@db.localtest.me:5432/splitwisest") ||
  process.env.SPLITWISEST_BASE_URL !== "http://127.0.0.1:3217") {
  throw new Error("This check requires the isolated local database and app");
}

const suffix = `gb${Date.now().toString(36)}`;
const password = crypto.randomUUID();
const date = new Date().toISOString().slice(0, 10);

async function lockMemberReads() {
  const child = spawn("docker", ["exec", "-i", "sw-group-balances-pg", "psql", "-X", "-qAt", "-U", "localtest", "-d", "splitwisest"]);
  const ready = new Promise<void>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("Could not lock local member reads")), 5000);
    child.stdout.on("data", (chunk) => {
      text += String(chunk);
      if (text.includes("locked")) { clearTimeout(timer); resolve(); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Local lock session exited: ${code}`)); });
  });
  child.stdin.write("BEGIN; LOCK TABLE group_members IN ACCESS EXCLUSIVE MODE; SELECT 'locked';\n");
  await ready;
  return child;
}

async function waitForBlockedMemberRead() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const rows = await sql`SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND (query LIKE '%group_members%' OR query LIKE '%group_balance_rows%')`;
    if (Number(rows[0].blocked) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Detail read did not reach the blocked member check");
}

async function main() {
  const [matthew, michael, jet, other, outsider] = await Promise.all([
    signup("matthew", suffix, password), signup("michael", suffix, password),
    signup("jet", suffix, password), signup("other", suffix, password), signup("outsider", suffix, password),
  ]);
  const group = await request("/api/groups", { cookie: matthew.cookie,
    body: { name: `QA Group balance ${suffix}`, currency: "USD" } });
  assert(group.res.ok, `create group: ${group.text}`);
  const groupId = jsonNumber(group.json.id, "group id");
  for (const member of [michael, jet, other]) {
    const joined = await request("/api/groups/join", { cookie: member.cookie, body: { code: group.json.inviteCode } });
    assert(joined.res.ok, `join: ${joined.text}`);
  }
  const expense = await request(`/api/groups/${groupId}/expenses`, { cookie: matthew.cookie,
    body: { title: "Ordinary reimbursement", amountCents: 1000, currency: "USD", date,
      payerId: matthew.id, categoryId: null, notes: "", splitMethod: "equal", participants: [{ userId: jet.id }] } });
  assert(expense.res.ok, `ordinary reimbursement: ${expense.text}`);

  async function snapshot(): Promise<[number, number][]> {
    const result = await request(`/api/groups/${groupId}`, { cookie: matthew.cookie });
    assert(result.res.ok, `group overview: ${result.text}`);
    return jsonArray(result.json.balances, "balances").map((item) => {
      const row = jsonObject(item, "balance");
      return [jsonNumber(row.userId, "user id"), jsonNumber(row.netCents, "net")] as [number, number];
    }).sort((a, b) => a[0] - b[0]);
  }
  async function nets() { return new Map(await snapshot()); }

  const body = { clientRequestId: crypto.randomUUID(), title: "Shared obligations", amountCents: 12000,
    owes: { method: "equal", participants: [matthew, michael, jet].map((m) => ({ userId: m.id })) },
    receives: { method: "exact", participants: [
      { userId: matthew.id, value: 8000 }, { userId: michael.id, value: 4000 },
    ] }, expectedBalances: await snapshot(),
  };
  const path = `/api/groups/${groupId}/group-balances`;
  for (const invalid of [
    { ...body, receives: { method: "equal", participants: [] } },
    { ...body, receives: { method: "exact", participants: [{ userId: matthew.id, value: 11999 }] } },
    { ...body, receives: { method: "exact", participants: [{ userId: matthew.id, value: -1 }] } },
    { ...body, receives: { method: "equal", participants: [{ userId: outsider.id }] } },
    { ...body, receives: { method: "equal", participants: [{ userId: matthew.id }, { userId: matthew.id }] } },
    { ...body, receives: { method: "percentage", participants: [{ userId: matthew.id, value: 99 }] } },
    { ...body, amountCents: 100_000_000_000, receives: { method: "percentage", participants: [
      { userId: matthew.id, value: 50 }, { userId: michael.id, value: 50.0009 },
    ] } },
    { ...body, receives: { method: "shares", participants: [
      { userId: matthew.id, value: 0.00000001 }, { userId: michael.id, value: 1 },
    ] } },
    ...(["exact", "percentage", "shares"] as const).map((method) => ({ ...body,
      receives: { method, participants: [
        { userId: matthew.id, value: method === "exact" ? 12000 : method === "percentage" ? 100 : 1 },
        { userId: michael.id },
      ] },
    })),
  ]) {
    const rejected = await request(path, { cookie: matthew.cookie, body: invalid });
    assert(rejected.res.status === 400, `invalid allocation was accepted: ${rejected.text}`);
  }
  const forbidden = await request(path, { cookie: outsider.cookie, body });
  assert(forbidden.res.status === 403, "outsider could create group balance");

  const created = await request(path, { cookie: matthew.cookie, body });
  assert(created.res.ok, `create group balance: ${created.text}`);
  const id = jsonNumber(created.json.id, "group balance id");
  const staleCreate = await request(path, { cookie: michael.cookie, body: { ...body, title: "Stale preview" } });
  assert(staleCreate.res.status === 400 && String(staleCreate.json.error).includes("Refresh"),
    "a second balance changed the preview but stale create was accepted");
  console.log("snapshot gate: stale create rejected");
  let current = await nets();
  assert(current.get(matthew.id) === 5000 && current.get(michael.id) === 0 &&
    current.get(jet.id) === -5000 && current.get(other.id) === 0, "created nets did not match");
  const list = await request(path, { cookie: matthew.cookie });
  assert(jsonArray(list.json.balances, "group balance list").length === 1, "group balance missing or duplicated");
  const detail = await request(`/api/group-balances/${id}`, { cookie: michael.cookie });
  assert(detail.res.ok, `reopen: ${detail.text}`);
  const saved = jsonObject(detail.json.balance, "saved balance");
  assert(jsonObject(saved.owes, "saved owes").method === "equal", "owed method lost");
  assert(jsonObject(saved.receives, "saved receives").method === "exact", "receive method lost");

  const edit = { title: "Revised obligations", amountCents: 101,
    owes: { method: "shares", participants: [
      { userId: matthew.id, value: 1 }, { userId: michael.id, value: 2 }, { userId: jet.id, value: 1 },
    ] },
    receives: { method: "percentage", participants: [
      { userId: matthew.id, value: 50 }, { userId: michael.id, value: 50 },
    ] },
    expectedUpdatedAt: saved.updatedAt, expectedBalances: await snapshot(),
  };
  const concurrent = await request(path, { cookie: michael.cookie, body: { clientRequestId: crypto.randomUUID(),
    title: "Concurrent change", amountCents: 100,
    owes: { method: "equal", participants: [{ userId: jet.id }] },
    receives: { method: "equal", participants: [{ userId: matthew.id }] },
    expectedBalances: await snapshot(),
  } });
  assert(concurrent.res.ok, `concurrent balance: ${concurrent.text}`);
  const staleGroupEdit = await request(`/api/group-balances/${id}`, { cookie: matthew.cookie, method: "PATCH", body: edit });
  assert(staleGroupEdit.res.status === 400, "group changed after preview but edit was accepted");
  console.log("snapshot gate: concurrent group edit rejected");
  const concurrentId = jsonNumber(concurrent.json.id, "concurrent id");
  const concurrentDetail = await request(`/api/group-balances/${concurrentId}`, { cookie: michael.cookie });
  const concurrentVersion = String(jsonObject(concurrentDetail.json.balance, "concurrent detail").updatedAt);
  const removedConcurrent = await request(`/api/group-balances/${concurrentId}?expectedUpdatedAt=${encodeURIComponent(concurrentVersion)}`,
    { cookie: michael.cookie, method: "DELETE" });
  assert(removedConcurrent.res.ok, `remove concurrent change: ${removedConcurrent.text}`);
  const edited = await request(`/api/group-balances/${id}`, { cookie: matthew.cookie, method: "PATCH",
    body: { ...edit, expectedBalances: await snapshot() } });
  assert(edited.res.ok, `edit: ${edited.text}`);
  current = await nets();
  const matthewCredit = matthew.id < michael.id ? 51 : 50;
  assert(current.get(matthew.id) === 1000 + matthewCredit - 25 &&
    current.get(michael.id) === 101 - matthewCredit - 51 &&
    current.get(jet.id) === -1025 && current.get(other.id) === 0, "edited nets or cent rounding did not match");
  const reopened = await request(`/api/group-balances/${id}`, { cookie: matthew.cookie });
  const reopenedRow = jsonObject(reopened.json.balance, "reopened balance");
  assert(jsonObject(reopenedRow.owes, "owed side").method === "shares" &&
    jsonObject(reopenedRow.receives, "received side").method === "percentage", "edited methods lost");
  assert(jsonArray(jsonObject(reopenedRow.owes, "owed side").participants, "owed people").length === 3,
    "edited selection lost");
  const stale = await request(`/api/group-balances/${id}`, { cookie: matthew.cookie, method: "PATCH",
    body: { ...edit, expectedBalances: await snapshot() } });
  assert(stale.res.status === 400 && String(stale.json.error).includes("Close and reopen"),
    "same-record stale edit did not require reopen");
  const afterList = await request(path, { cookie: matthew.cookie });
  assert(jsonArray(afterList.json.balances, "group balance list").length === 1, "edit added a duplicate record");
  const deleted = await request(`/api/group-balances/${id}?expectedUpdatedAt=${encodeURIComponent(String(reopenedRow.updatedAt))}`,
    { cookie: matthew.cookie, method: "DELETE" });
  assert(deleted.res.ok, `delete: ${deleted.text}`);
  current = await nets();
  assert(current.get(matthew.id) === 1000 && current.get(jet.id) === -1000 &&
    current.get(michael.id) === 0 && current.get(other.id) === 0, "delete did not restore reimbursement balances");

  const zero = await request(path, { cookie: matthew.cookie, body: { clientRequestId: crypto.randomUUID(),
    title: "Explicit zero", amountCents: 100,
    owes: { method: "equal", participants: [{ userId: jet.id }] },
    receives: { method: "exact", participants: [
      { userId: matthew.id, value: 100 }, { userId: michael.id, value: 0 },
    ] }, expectedBalances: await snapshot(),
  } });
  assert(zero.res.ok, `explicit zero create: ${zero.text}`);
  const zeroId = jsonNumber(zero.json.id, "zero id");
  const zeroDetail = await request(`/api/group-balances/${zeroId}`, { cookie: matthew.cookie });
  const zeroRow = jsonObject(zeroDetail.json.balance, "zero detail");
  const zeroParticipants = jsonArray(jsonObject(zeroRow.receives, "zero receive side").participants, "zero participants");
  assert(zeroParticipants.some((p) => {
    const value = jsonObject(p, "zero participant");
    return value.userId === michael.id && value.value === 0;
  }), "explicit zero did not survive reopen");
  const zeroRename = await request(`/api/group-balances/${zeroId}`, { cookie: matthew.cookie, method: "PATCH", body: {
    title: "Explicit zero renamed", amountCents: 100,
    owes: { method: "equal", participants: [{ userId: jet.id }] },
    receives: { method: "exact", participants: [
      { userId: matthew.id, value: 100 }, { userId: michael.id, value: 0 },
    ] }, expectedUpdatedAt: zeroRow.updatedAt, expectedBalances: await snapshot(),
  } });
  assert(zeroRename.res.ok, `explicit zero title edit: ${zeroRename.text}`);
  const zeroLatest = await request(`/api/group-balances/${zeroId}`, { cookie: matthew.cookie });
  const zeroVersion = String(jsonObject(zeroLatest.json.balance, "zero latest").updatedAt);
  const zeroDeleted = await request(`/api/group-balances/${zeroId}?expectedUpdatedAt=${encodeURIComponent(zeroVersion)}`,
    { cookie: matthew.cookie, method: "DELETE" });
  assert(zeroDeleted.res.ok, `explicit zero delete: ${zeroDeleted.text}`);
  console.log("weighted inputs: missing values rejected; explicit zero survived create, reopen, and title edit");

  const legacy = await request(path, { cookie: matthew.cookie, body: { clientRequestId: crypto.randomUUID(), title: "Legacy tie", amountCents: 1,
    owes: { method: "equal", participants: [{ userId: matthew.id }, { userId: michael.id }] },
    receives: { method: "equal", participants: [{ userId: jet.id }] },
    expectedBalances: await snapshot(),
  } });
  assert(legacy.res.ok, `legacy tie: ${legacy.text}`);
  const legacyId = jsonNumber(legacy.json.id, "legacy id");
  let parentInsertRejected = false;
  try {
    await sql`INSERT INTO group_obligations (group_id, title, amount_cents, owed_method, receive_method, created_by)
      VALUES (${groupId}, 'Invalid parent only', 100, 'equal', 'equal', ${matthew.id})`;
  } catch { parentInsertRejected = true; }
  assert(parentInsertRejected, "parent-only insert committed without both allocation sides");
  let parentUpdateRejected = false;
  try {
    await sql`UPDATE group_obligations SET amount_cents = 2 WHERE id = ${legacyId}`;
  } catch { parentUpdateRejected = true; }
  assert(parentUpdateRejected, "parent-only total update committed with mismatched sides");
  console.log("deferred invariant: parent-only insert and total update rejected");
  const oldWinner = Math.max(matthew.id, michael.id);
  const oldLoser = Math.min(matthew.id, michael.id);
  await sql.transaction((tx) => [
    tx`UPDATE group_obligation_allocations SET share_cents = CASE WHEN user_id = ${oldWinner} THEN 1 ELSE 0 END
      WHERE obligation_id = ${legacyId} AND side = 'owes'`,
    tx`UPDATE users SET display_name = CASE WHEN id = ${oldWinner} THEN 'A legacy winner' ELSE 'Z legacy loser' END
      WHERE id IN (${oldWinner}, ${oldLoser})`,
  ]);
  const legacyBefore = await request(`/api/group-balances/${legacyId}`, { cookie: matthew.cookie });
  const legacyRow = jsonObject(legacyBefore.json.balance, "legacy balance");
  const renamed = await request(`/api/group-balances/${legacyId}`, { cookie: matthew.cookie, method: "PATCH",
    body: { title: "Legacy tie renamed", amountCents: 1,
      owes: { method: "equal", participants: [{ userId: oldLoser }, { userId: oldWinner }] },
      receives: { method: "equal", participants: [{ userId: jet.id }] },
      expectedUpdatedAt: legacyRow.updatedAt, expectedBalances: await snapshot(),
    } });
  assert(renamed.res.ok, `title edit after display-name reorder: ${renamed.text}`);
  const legacyAfter = await request(`/api/group-balances/${legacyId}`, { cookie: matthew.cookie });
  const owedRows = jsonArray(jsonObject(jsonObject(legacyAfter.json.balance, "legacy after").owes, "owed side").participants, "owed rows");
  assert(jsonNumber(jsonObject(owedRows.find((p) => jsonObject(p, "owed row").userId === oldWinner), "winner").shareCents, "share") === 1,
    "title-only edit moved a rounding cent after display-name reorder");
  console.log("rounding: title edit retained legacy awarded cent after display-name reorder");

  const atomic = await request(path, { cookie: matthew.cookie, body: { clientRequestId: crypto.randomUUID(),
    title: "Atomic detail", amountCents: 100,
    owes: { method: "equal", participants: [{ userId: jet.id }] },
    receives: { method: "equal", participants: [{ userId: matthew.id }] },
    expectedBalances: await snapshot(),
  } });
  assert(atomic.res.ok, `atomic fixture: ${atomic.text}`);
  const atomicId = jsonNumber(atomic.json.id, "atomic id");
  let reparentRejected = false;
  try {
    await sql`UPDATE group_obligation_allocations SET obligation_id = ${atomicId}
      WHERE obligation_id = ${legacyId} AND side = 'owes' AND user_id = ${oldWinner}`;
  } catch { reparentRejected = true; }
  assert(reparentRejected, "allocation parent changed");
  const originalAllocation = await sql`SELECT count(*)::int AS count FROM group_obligation_allocations
    WHERE obligation_id = ${legacyId} AND side = 'owes' AND user_id = ${oldWinner}`;
  assert(Number(originalAllocation[0].count) === 1, "rejected reparent did not preserve its original row");
  console.log("immutable parent: allocation reparenting rejected");
  const legacyUpdated = jsonObject(legacyAfter.json.balance, "legacy updated");
  const removedLegacy = await request(`/api/group-balances/${legacyId}?expectedUpdatedAt=${encodeURIComponent(String(legacyUpdated.updatedAt))}`,
    { cookie: matthew.cookie, method: "DELETE" });
  assert(removedLegacy.res.ok, `remove legacy tie: ${removedLegacy.text}`);
  const memberLock = await lockMemberReads();
  let blockedRead: ReturnType<typeof request> | null = null;
  try {
    blockedRead = request(`/api/group-balances/${atomicId}`, { cookie: matthew.cookie });
    await waitForBlockedMemberRead();
    await sql.transaction((tx) => [
      tx`UPDATE group_obligations SET amount_cents = 200, owed_method = 'exact', receive_method = 'exact',
        updated_at = now() WHERE id = ${atomicId}`,
      tx`UPDATE group_obligation_allocations SET share_cents = 200, raw_input = 200 WHERE obligation_id = ${atomicId}`,
    ]);
  } finally {
    memberLock.stdin.end("ROLLBACK;\n");
  }
  assert(blockedRead, "detail request did not start");
  const atomicRead = await blockedRead;
  assert(atomicRead.res.ok, `atomic read: ${atomicRead.text}`);
  const atomicRow = jsonObject(atomicRead.json.balance, "atomic read");
  const atomicOwes = jsonObject(atomicRow.owes, "atomic owed side");
  const atomicAllocations = jsonArray(atomicOwes.participants, "atomic allocations");
  const atomicAmount = jsonNumber(atomicRow.amountCents, "atomic amount");
  const atomicShare = jsonNumber(jsonObject(atomicAllocations[0], "atomic share").shareCents, "atomic share cents");
  assert((atomicAmount === 100 && atomicOwes.method === "equal" && atomicShare === 100) ||
    (atomicAmount === 200 && atomicOwes.method === "exact" && atomicShare === 200),
    "reopen combined the old parent with new allocations");
  console.log("detail read: parent and allocations stayed in one snapshot during forced race");
  const atomicCurrent = await request(`/api/group-balances/${atomicId}`, { cookie: matthew.cookie });
  const atomicVersion = String(jsonObject(atomicCurrent.json.balance, "atomic current").updatedAt);
  const removedAtomic = await request(`/api/group-balances/${atomicId}?expectedUpdatedAt=${encodeURIComponent(atomicVersion)}`,
    { cookie: matthew.cookie, method: "DELETE" });
  assert(removedAtomic.res.ok, `remove atomic fixture: ${removedAtomic.text}`);

  for (let n = 0; n < 51; n++) {
    const added = await request(path, { cookie: matthew.cookie, body: { ...body, clientRequestId: crypto.randomUUID(), title: `Page ${n}`, expectedBalances: await snapshot() } });
    assert(added.res.ok, `page fixture ${n}: ${added.text}`);
  }
  const firstPage = await request(`${path}?limit=50`, { cookie: matthew.cookie });
  const firstRows = jsonArray(firstPage.json.balances, "first page");
  assert(firstRows.length === 50 && firstPage.json.hasMore === true, "first page or next-page flag wrong");
  const cursor = jsonNumber(jsonObject(firstRows.at(-1), "last first-page row").id, "cursor");
  const secondPage = await request(`${path}?limit=50&before=${cursor}`, { cookie: matthew.cookie });
  const secondRows = jsonArray(secondPage.json.balances, "second page");
  assert(secondRows.length === 1 && secondPage.json.hasMore === false, "cursor page wrong");
  console.log("pagination: 51 records loaded through the cursor");
  const badCursor = await request(`${path}?before=bad`, { cookie: matthew.cookie });
  assert(badCursor.res.status === 400, "invalid cursor was accepted");

  const zeroRef = await request(path, { cookie: matthew.cookie, body: { clientRequestId: crypto.randomUUID(),
    title: "Zero-share member guard", amountCents: 100,
    owes: { method: "exact", participants: [
      { userId: matthew.id, value: 100 }, { userId: other.id, value: 0 },
    ] },
    receives: { method: "equal", participants: [{ userId: matthew.id }] },
    expectedBalances: await snapshot(),
  } });
  assert(zeroRef.res.ok, `zero-share guard fixture: ${zeroRef.text}`);
  const zeroRefId = jsonNumber(zeroRef.json.id, "zero-ref id");
  const blockedLeave = await request(`/api/groups/${groupId}/members/${other.id}`,
    { cookie: other.cookie, method: "DELETE" });
  assert(blockedLeave.res.status === 400 && String(blockedLeave.json.error).includes("group balance") &&
    String(blockedLeave.json.error).includes("before leaving"),
    `zero-share member got a false or unactionable leave result: ${blockedLeave.text}`);
  const blockedRemoval = await request(`/api/groups/${groupId}/members/${other.id}`,
    { cookie: matthew.cookie, method: "DELETE" });
  assert(blockedRemoval.res.status === 400 && String(blockedRemoval.json.error).includes("group balance") &&
    String(blockedRemoval.json.error).includes("before removing"),
    `zero-share member got a false or unactionable removal result: ${blockedRemoval.text}`);
  const guarded = await request(`/api/group-balances/${zeroRefId}`, { cookie: matthew.cookie });
  assert(guarded.res.ok, `zero-share guard detail: ${guarded.text}`);
  const guardedVersion = String(jsonObject(guarded.json.balance, "guarded balance").updatedAt);
  const noOther = await request(`/api/group-balances/${zeroRefId}`, { cookie: matthew.cookie, method: "PATCH", body: {
    title: "Zero-share member removed", amountCents: 100,
    owes: { method: "equal", participants: [{ userId: matthew.id }] },
    receives: { method: "equal", participants: [{ userId: matthew.id }] },
    expectedUpdatedAt: guardedVersion, expectedBalances: await snapshot(),
  } });
  assert(noOther.res.ok, `remove zero-share reference: ${noOther.text}`);
  const safeRemoval = await request(`/api/groups/${groupId}/members/${other.id}`,
    { cookie: matthew.cookie, method: "DELETE" });
  assert(safeRemoval.res.ok, `safe removal after allocation edit: ${safeRemoval.text}`);
  const afterRemoval = await request(`/api/groups/${groupId}`, { cookie: matthew.cookie });
  assert(afterRemoval.res.ok && !jsonArray(afterRemoval.json.members, "members after removal")
    .some((member) => jsonObject(member, "remaining member").id === other.id),
    "removed member still appears in the group");
  console.log("member guard: zero-share reference explained; editing it allowed safe removal");
  console.log("group balances API: validation, stale previews, stable cents after rename, edit, delete, reimbursement isolation, and cursor pagination passed");
}

main().finally(() => cleanupQaUsers(suffix)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
