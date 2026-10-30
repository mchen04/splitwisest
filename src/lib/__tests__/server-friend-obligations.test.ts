import { beforeEach, describe, expect, it, vi } from "vitest";

const { sql, transaction } = vi.hoisted(() => ({ sql: vi.fn(), transaction: vi.fn() }));

vi.mock("../db", () => ({ sql: Object.assign(sql, { transaction }) }));

import { friendGroupObligationsSnapshot, friendObligations, netObligations, pairwiseFriendObligations } from "../balances";

const groupRows = [
  { group_id: "9", group_name: "Trip", currency: "USD", user_id: "1", net_cents: "101" },
  { group_id: "9", group_name: "Trip", currency: "USD", user_id: "2", net_cents: "-101" },
];
const directRows = [
  { friend_id: "2", currency: "USD", net_cents: "-40" },
  { friend_id: "2", currency: "JPY", net_cents: "100" },
  { friend_id: "3", currency: "USD", net_cents: "0" },
];

beforeEach(() => {
  sql.mockReset();
  transaction.mockReset();
  transaction.mockImplementation(async (queries) => {
    queries(sql);
    return [groupRows, directRows];
  });
});

describe("friend obligations", () => {
  it("loads group and direct balances in one read-only request", async () => {
    const result = await friendObligations(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0][1]).toEqual({ readOnly: true });
    expect(sql).toHaveBeenCalledTimes(2);
    expect(result.get(2)).toEqual([
      { groupId: null, groupName: null, currency: "JPY", netCents: 100 },
      { groupId: null, groupName: null, currency: "USD", netCents: -40 },
      { groupId: 9, groupName: "Trip", currency: "USD", netCents: 101 },
    ]);
    expect(result.has(3)).toBe(false);
    expect(netObligations(result.get(2)!)).toEqual({ JPY: 100, USD: 61 });
  });

  it("preserves the full group snapshot", async () => {
    sql.mockResolvedValue(groupRows);
    const result = await friendGroupObligationsSnapshot(1);
    expect(result.snapshots).toEqual([{ groupId: 9, balances: [[1, 101], [2, -101]] }]);
    expect(result.byFriend.get(2)).toEqual([{ groupId: 9, groupName: "Trip", currency: "USD", netCents: 101 }]);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("keeps the viewer's debt negative", async () => {
    transaction.mockImplementation(async (queries) => {
      queries(sql);
      return [groupRows, []];
    });
    expect(await pairwiseFriendObligations(2, 1)).toEqual([
      { groupId: 9, groupName: "Trip", currency: "USD", netCents: -101 },
    ]);
    expect(sql.mock.calls[0].slice(1)).toEqual([2, 1, 1]);
  });

  it("keeps third-party transfers out of the viewer's obligations", async () => {
    transaction.mockResolvedValue([[...groupRows,
      { group_id: "10", group_name: "Other", currency: "USD", user_id: "1", net_cents: "0" },
      { group_id: "10", group_name: "Other", currency: "USD", user_id: "3", net_cents: "50" },
      { group_id: "10", group_name: "Other", currency: "USD", user_id: "4", net_cents: "-50" },
    ], []]);
    expect([...(await friendObligations(1)).keys()]).toEqual([2]);
  });

  it("propagates a failed read without returning partial balances", async () => {
    transaction.mockRejectedValue(new Error("database unavailable"));
    await expect(friendObligations(1)).rejects.toThrow("database unavailable");
  });
});
