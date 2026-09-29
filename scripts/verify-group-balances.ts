import { assert, cleanupQaUsers, jsonArray, jsonNumber, jsonObject, request, signup } from "./qa-support";

if (process.env.NEON_LOCAL_PROXY !== "http://127.0.0.1:4445/sql" ||
  !process.env.DATABASE_URL?.includes("@db.localtest.me:5432/splitwisest") ||
  process.env.SPLITWISEST_BASE_URL !== "http://127.0.0.1:3217") {
  throw new Error("This check requires the isolated local database and app");
}

const suffix = `gb${Date.now().toString(36)}`;
const password = crypto.randomUUID();
const date = new Date().toISOString().slice(0, 10);

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

  const body = { title: "Shared obligations", amountCents: 12000,
    owes: { method: "equal", participants: [matthew, michael, jet].map((m) => ({ userId: m.id })) },
    receives: { method: "exact", participants: [
      { userId: matthew.id, value: 8000 }, { userId: michael.id, value: 4000 },
    ] },
  };
  const path = `/api/groups/${groupId}/group-balances`;
  for (const invalid of [
    { ...body, receives: { method: "equal", participants: [] } },
    { ...body, receives: { method: "exact", participants: [{ userId: matthew.id, value: 11999 }] } },
    { ...body, receives: { method: "exact", participants: [{ userId: matthew.id, value: -1 }] } },
    { ...body, receives: { method: "equal", participants: [{ userId: outsider.id }] } },
    { ...body, receives: { method: "equal", participants: [{ userId: matthew.id }, { userId: matthew.id }] } },
    { ...body, receives: { method: "percentage", participants: [{ userId: matthew.id, value: 99 }] } },
  ]) {
    const rejected = await request(path, { cookie: matthew.cookie, body: invalid });
    assert(rejected.res.status === 400, `invalid allocation was accepted: ${rejected.text}`);
  }
  const forbidden = await request(path, { cookie: outsider.cookie, body });
  assert(forbidden.res.status === 403, "outsider could create group balance");

  const created = await request(path, { cookie: matthew.cookie, body });
  assert(created.res.ok, `create group balance: ${created.text}`);
  const id = jsonNumber(created.json.id, "group balance id");
  async function nets() {
    const result = await request(`/api/groups/${groupId}`, { cookie: matthew.cookie });
    assert(result.res.ok, `group overview: ${result.text}`);
    return new Map(jsonArray(result.json.balances, "balances").map((item) => {
      const row = jsonObject(item, "balance");
      return [jsonNumber(row.userId, "user id"), jsonNumber(row.netCents, "net")] as const;
    }));
  }
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
    expectedUpdatedAt: saved.updatedAt,
  };
  const edited = await request(`/api/group-balances/${id}`, { cookie: matthew.cookie, method: "PATCH", body: edit });
  assert(edited.res.ok, `edit: ${edited.text}`);
  current = await nets();
  assert(current.get(matthew.id) === 1026 && current.get(michael.id) === -1 &&
    current.get(jet.id) === -1025 && current.get(other.id) === 0, "edited nets or cent rounding did not match");
  const reopened = await request(`/api/group-balances/${id}`, { cookie: matthew.cookie });
  const reopenedRow = jsonObject(reopened.json.balance, "reopened balance");
  assert(jsonObject(reopenedRow.owes, "owed side").method === "shares" &&
    jsonObject(reopenedRow.receives, "received side").method === "percentage", "edited methods lost");
  assert(jsonArray(jsonObject(reopenedRow.owes, "owed side").participants, "owed people").length === 3,
    "edited selection lost");
  const stale = await request(`/api/group-balances/${id}`, { cookie: matthew.cookie, method: "PATCH", body: edit });
  assert(stale.res.status === 400, "stale edit did not fail");
  const afterList = await request(path, { cookie: matthew.cookie });
  assert(jsonArray(afterList.json.balances, "group balance list").length === 1, "edit added a duplicate record");
  const deleted = await request(`/api/group-balances/${id}?expectedUpdatedAt=${encodeURIComponent(String(reopenedRow.updatedAt))}`,
    { cookie: matthew.cookie, method: "DELETE" });
  assert(deleted.res.ok, `delete: ${deleted.text}`);
  current = await nets();
  assert(current.get(matthew.id) === 1000 && current.get(jet.id) === -1000 &&
    current.get(michael.id) === 0 && current.get(other.id) === 0, "delete did not restore reimbursement balances");
  for (let n = 0; n < 51; n++) {
    const added = await request(path, { cookie: matthew.cookie, body: { ...body, title: `Page ${n}` } });
    assert(added.res.ok, `page fixture ${n}: ${added.text}`);
  }
  const firstPage = await request(`${path}?limit=50`, { cookie: matthew.cookie });
  const firstRows = jsonArray(firstPage.json.balances, "first page");
  assert(firstRows.length === 50 && firstPage.json.hasMore === true, "first page or next-page flag wrong");
  const cursor = jsonNumber(jsonObject(firstRows.at(-1), "last first-page row").id, "cursor");
  const secondPage = await request(`${path}?limit=50&before=${cursor}`, { cookie: matthew.cookie });
  const secondRows = jsonArray(secondPage.json.balances, "second page");
  assert(secondRows.length === 1 && secondPage.json.hasMore === false, "cursor page wrong");
  const badCursor = await request(`${path}?before=bad`, { cookie: matthew.cookie });
  assert(badCursor.res.status === 400, "invalid cursor was accepted");
  console.log("group balances API: validation, create, reopen, edit, stale version, rounding, delete, reimbursement isolation, and cursor pagination passed");
}

main().finally(() => cleanupQaUsers(suffix)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
