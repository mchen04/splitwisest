import { z } from "zod";
import type { NeonQueryFunctionInTransaction } from "@neondatabase/serverless";
import { sql } from "./db";
import { computeShares, computeItemizedShares, fmtMoney, SplitMethod } from "./money";
import { convert, CURRENCIES } from "./fx";
import { currencyStep } from "./currencies";
import { ApiError, badRequest, forbidden, notFound } from "./api";
import { loadGroupMemberIds } from "./balances";
import { activityData } from "./activity";
import { Change, diffExpense, ExpenseSnapshot } from "./activity-diff";
import { VersionToken, versionToken } from "./versions";

export const ExpenseBody = z.object({
  title: z.string().trim().min(1, "Title is required").max(120),
  amountCents: z.number().int().positive("Amount must be positive").max(100_000_000_000),
  currency: z.string().refine((c) => CURRENCIES.includes(c), "Unsupported currency"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  payerId: z.number().int().positive(),
  categoryId: z.number().int().positive().nullable().optional(),
  notes: z.string().max(2000).default(""),
  splitMethod: z.enum(["equal", "exact", "percentage", "shares", "itemized"]),
  participants: z
    .array(z.object({ userId: z.number().int().positive(), value: z.number().min(0, "Values must be positive").optional() }))
    .min(1, "At least one participant is required"),
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        amountCents: z.number().int().min(0),
        participantIds: z.array(z.number().int().positive()).min(1),
      })
    )
    .optional(),
  itemizedTaxCents: z.number().int().min(0).optional(),
  itemizedTipCents: z.number().int().min(0).optional(),
  expectedUpdatedAt: VersionToken.optional(),
});

export type ExpenseInput = z.infer<typeof ExpenseBody>;

export async function validateExpenseActors(
  groupId: number,
  userId: number,
  input: { payerId: number; categoryId?: number | null; participants?: { userId: number }[]; participantIds?: number[] }
): Promise<Set<number>> {
  const memberIds = await loadGroupMemberIds(groupId);
  if (!memberIds.has(input.payerId)) badRequest("Payer must be a group member");
  const participantIds = input.participants?.map((p) => p.userId) ?? input.participantIds ?? [];
  for (const userId of participantIds) {
    if (!memberIds.has(userId)) badRequest("All participants must be group members");
  }
  const uniq = new Set(participantIds);
  if (uniq.size !== participantIds.length) badRequest("Duplicate participants");

  if (input.categoryId) {
    const cat = await sql`
      SELECT 1 FROM categories WHERE id = ${input.categoryId} AND (owner_id IS NULL OR owner_id = ${userId})`;
    if (cat.length === 0) badRequest("Unknown category");
  }
  return memberIds;
}

export async function validateExpense(groupId: number, userId: number, input: ExpenseInput) {
  const memberIds = await validateExpenseActors(groupId, userId, input);
  return validateExpenseShares(memberIds, input);
}

function validateExpenseShares(memberIds: Set<number>, input: ExpenseInput) {
  let shares: Map<number, number>;
  if (input.splitMethod === "itemized") {
    if (!input.items || input.items.length === 0) badRequest("Itemized expenses need at least one item");
    // Item participants must be both group members AND part of the expense's
    // declared participant set, so a crafted payload can't saddle a member with a
    // share via items without listing them as a participant (the form derives the
    // participant set from the items, so legitimate submissions always satisfy this).
    const declared = new Set(input.participants.map((p) => p.userId));
    for (const item of input.items!) {
      if (new Set(item.participantIds).size !== item.participantIds.length) {
        badRequest("Duplicate item participants");
      }
      for (const pid of item.participantIds) {
        if (!memberIds.has(pid)) badRequest("All item participants must be group members");
        if (!declared.has(pid)) badRequest("Item participants must be expense participants");
      }
    }
    // Zero-decimal currencies (JPY/KRW) split items in whole units so an itemized
    // bill never produces an unpayable sub-yen/sub-won share.
    shares = computeItemizedShares(
      input.amountCents,
      input.items!,
      { taxCents: input.itemizedTaxCents, tipCents: input.itemizedTipCents },
      currencyStep(input.currency)
    );
  } else {
    // Zero-decimal currencies (JPY/KRW) have no sub-unit: snap the amount to a
    // whole unit and split in whole units so no unsettleable sub-yen/sub-won
    // share is produced. Mutating input.amountCents here keeps the stored amount,
    // the FX conversion, and the share sum consistent (the same input object is
    // used for storage and convert()). step === 1 leaves 2-decimal flows untouched.
    const step = currencyStep(input.currency);
    if (step !== 1) input.amountCents = Math.round(input.amountCents / step) * step;
    shares = computeShares(input.splitMethod as SplitMethod, input.amountCents, input.participants, step);
  }
  return shares;
}

function sharesJson(shares: Map<number, number>, input: ExpenseInput): string {
  const rawByUser = new Map(input.participants.map((p) => [p.userId, p.value ?? null]));
  return JSON.stringify(
    [...shares.entries()].map(([userId, cents]) => ({
      user_id: userId,
      share_cents: cents,
      raw_input: rawByUser.get(userId) ?? null,
    }))
  );
}

function itemsJson(input: ExpenseInput): string {
  if (input.splitMethod !== "itemized" || !input.items) return "[]";
  return JSON.stringify(
    input.items.map((i) => ({
      name: i.name.trim() || "Item",
      amount_cents: i.amountCents,
      participant_ids: i.participantIds,
    }))
  );
}

function itemizedTaxCents(input: ExpenseInput): number {
  return input.splitMethod === "itemized" ? input.itemizedTaxCents ?? 0 : 0;
}

function itemizedTipCents(input: ExpenseInput): number {
  return input.splitMethod === "itemized" ? input.itemizedTipCents ?? 0 : 0;
}

function memberIdsJson(userIds: number[]): string {
  return JSON.stringify(userIds.map((userId) => ({ user_id: userId })));
}

// Insert the expense, its shares, and its items in one transaction. The first
// statement takes the group lock; the second statement reads membership from a
// fresh snapshot after any lock wait.
export async function insertExpense(
  groupId: number,
  groupCurrency: string,
  createdBy: number,
  input: ExpenseInput,
  opts: {
    recurring?: {
      id: number;
      currentDate: string;
      nextDate: string;
      cadence: string;
      storedAnchorDay: number | null;
      effectiveAnchorDay: number;
    } | null;
    activity?: { actorName: string; type: string; actionText: string } | null;
  } = {}
): Promise<number | null> {
  const recurringId = opts.recurring?.id ?? null;
  const shares = recurringId === null
    ? await validateExpense(groupId, createdBy, input)
    : validateExpenseShares(await loadGroupMemberIds(groupId), input);
  const { cents: convertedCents, rate } = await convert(input.amountCents, input.currency, groupCurrency);
  const summary = opts.activity ? `${opts.activity.actorName} ${opts.activity.actionText}` : null;
  const data = opts.activity ? activityData({}, opts.activity.actionText) : "{}";
  const recurringCurrentDate = opts.recurring?.currentDate ?? null;
  const recurringNextDate = opts.recurring?.nextDate ?? null;
  const recurringCadence = opts.recurring?.cadence ?? null;
  const recurringStoredAnchorDay = opts.recurring?.storedAnchorDay ?? null;
  const recurringEffectiveAnchorDay = opts.recurring?.effectiveAnchorDay ?? null;
  const activityType = opts.activity?.type ?? null;
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${groupId}::int)`,
    tx`
    WITH share_rows AS (
      SELECT x.user_id, x.share_cents, x.raw_input
      FROM jsonb_to_recordset(${sharesJson(shares, input)}::jsonb)
        AS x(user_id bigint, share_cents bigint, raw_input numeric)
    ),
    members_ok AS (
      SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = ${groupId} AND user_id = ${input.payerId}
      )
      AND (
        ${recurringId}::bigint IS NOT NULL OR ${activityType}::text IS NULL OR EXISTS (
          SELECT 1 FROM group_members
          WHERE group_id = ${groupId} AND user_id = ${createdBy}
        )
      )
      AND (
        ${recurringId}::bigint IS NULL OR ${input.categoryId ?? null}::bigint IS NULL OR EXISTS (
          SELECT 1 FROM categories
          WHERE id = ${input.categoryId ?? null}
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM share_rows sr
        WHERE NOT EXISTS (
          SELECT 1 FROM group_members gm
          WHERE gm.group_id = ${groupId} AND gm.user_id = sr.user_id
        )
      )
    ),
    claimed_recurring AS (
      UPDATE recurring_expenses SET next_date = ${recurringNextDate}, anchor_day = ${recurringEffectiveAnchorDay},
        updated_at = now()
      FROM members_ok
      WHERE id = ${recurringId}
        AND next_date = ${recurringCurrentDate}
        AND active
        AND title = ${input.title}
        AND amount_cents = ${input.amountCents}
        AND currency = ${input.currency}
        AND payer_id = ${input.payerId}
        AND category_id IS NOT DISTINCT FROM ${input.categoryId ?? null}
        AND notes = ${input.notes}
        AND cadence = ${recurringCadence}
        AND anchor_day IS NOT DISTINCT FROM ${recurringStoredAnchorDay}
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(participant_ids) AS p(user_id)
          FULL JOIN (SELECT user_id FROM share_rows) sr USING (user_id)
          WHERE p.user_id IS NULL OR sr.user_id IS NULL
        )
      RETURNING id
    ),
    insert_gate AS (
      SELECT NULL::bigint AS recurring_id FROM members_ok WHERE ${recurringId}::bigint IS NULL
      UNION ALL
      SELECT id FROM claimed_recurring
    ),
    e AS (
      INSERT INTO expenses (group_id, title, amount_cents, currency, converted_cents, fx_rate,
        expense_date, payer_id, category_id, notes, split_method, itemized_tax_cents,
        itemized_tip_cents, recurring_id, created_by)
      SELECT ${groupId}, ${input.title}, ${input.amountCents}, ${input.currency}, ${convertedCents},
        ${rate}, ${input.date}, ${input.payerId}, ${input.categoryId ?? null}, ${input.notes},
        ${input.splitMethod}, ${itemizedTaxCents(input)}, ${itemizedTipCents(input)},
        insert_gate.recurring_id, ${createdBy}
      FROM insert_gate
      RETURNING id
    ),
    s AS (
      INSERT INTO expense_shares (expense_id, user_id, share_cents, raw_input)
      SELECT e.id, x.user_id, x.share_cents, x.raw_input
      FROM e, share_rows x
      RETURNING 1
    ),
    it AS (
      INSERT INTO expense_items (expense_id, name, amount_cents, participant_ids)
      SELECT e.id, x.name, x.amount_cents,
        ARRAY(SELECT jsonb_array_elements_text(x.participant_ids)::bigint)
      FROM e, jsonb_to_recordset(${itemsJson(input)}::jsonb)
        AS x(name text, amount_cents bigint, participant_ids jsonb)
      RETURNING 1
    ),
    a AS (
      INSERT INTO activity (group_id, actor_id, type, summary, data)
      SELECT ${groupId}, ${createdBy}, ${activityType}, ${summary},
        jsonb_set(${data}::jsonb, '{expenseId}', to_jsonb(e.id))
      FROM e
      WHERE ${activityType}::text IS NOT NULL
      RETURNING 1
    )
    SELECT e.id FROM e`,
  ]);
  return rows[0] ? Number(rows[0].id) : null;
}

export async function createExpenseWithActivity(
  groupId: number,
  groupCurrency: string,
  createdBy: { id: number; displayName: string },
  input: ExpenseInput
): Promise<number> {
  const actionText = `added "${input.title}" (${fmtMoney(input.amountCents, input.currency)})`;
  const id = await insertExpense(groupId, groupCurrency, createdBy.id, input, {
    activity: { actorName: createdBy.displayName, type: "expense.added", actionText },
  });
  if (id === null) badRequest("Payer and participants must be group members");
  return id;
}

/** Reads the expense as it stands, with the display names the activity feed needs. */
async function loadExpenseSnapshot(expenseId: number): Promise<ExpenseSnapshot | null> {
  const rows = await sql`
    SELECT e.title, e.amount_cents, e.currency, e.notes, e.split_method,
      to_char(e.expense_date, 'YYYY-MM-DD') AS date,
      pu.display_name AS payer_name, c.name AS category_name,
      COALESCE(
        jsonb_agg(
          jsonb_build_object('userId', es.user_id, 'name', su.display_name,
            'shareCents', es.share_cents, 'rawInput', es.raw_input)
        ) FILTER (WHERE es.user_id IS NOT NULL), '[]'::jsonb) AS shares
    FROM expenses e
    JOIN users pu ON pu.id = e.payer_id
    LEFT JOIN categories c ON c.id = e.category_id
    LEFT JOIN expense_shares es ON es.expense_id = e.id
    LEFT JOIN users su ON su.id = es.user_id
    WHERE e.id = ${expenseId}
    GROUP BY e.id, pu.display_name, c.name`;
  const r = rows[0];
  if (!r) return null;
  return {
    title: r.title as string,
    amountCents: Number(r.amount_cents),
    currency: r.currency as string,
    date: r.date as string,
    payerName: r.payer_name as string,
    categoryName: (r.category_name as string | null) ?? null,
    notes: (r.notes as string | null) ?? "",
    splitMethod: r.split_method as string,
    shares: (r.shares as { userId: number; name: string; shareCents: number; rawInput: string | number | null }[])
      .map((s) => ({
        userId: Number(s.userId),
        name: s.name,
        shareCents: Number(s.shareCents),
        rawInput: s.rawInput === null ? null : Number(s.rawInput),
      })),
  };
}

/** Builds the post-edit snapshot from the submitted input, resolving display names. */
async function nextExpenseSnapshot(
  input: ExpenseInput,
  shares: Map<number, number>
): Promise<ExpenseSnapshot> {
  const userIds = [...new Set([input.payerId, ...shares.keys()])];
  const [people, categories] = await Promise.all([
    sql`SELECT id, display_name FROM users WHERE id = ANY(${userIds})`,
    input.categoryId
      ? sql`SELECT name FROM categories WHERE id = ${input.categoryId}`
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);
  const nameById = new Map(people.map((p) => [Number(p.id), p.display_name as string]));
  const rawByUser = new Map(input.participants.map((p) => [p.userId, p.value ?? null]));
  return {
    title: input.title,
    amountCents: input.amountCents,
    currency: input.currency,
    date: input.date,
    payerName: nameById.get(input.payerId) ?? "",
    categoryName: (categories[0]?.name as string | undefined) ?? null,
    notes: input.notes,
    splitMethod: input.splitMethod,
    shares: [...shares.entries()].map(([userId, cents]) => ({
      userId,
      name: nameById.get(userId) ?? "",
      shareCents: cents,
      rawInput: rawByUser.get(userId) ?? null,
    })),
  };
}

export async function updateExpenseWithActivity(
  expenseId: number,
  groupId: number,
  groupCurrency: string,
  user: { id: number; displayName: string },
  input: ExpenseInput,
  prev: { amountCents: number; currency: string; convertedCents: number; fxRate: number }
) {
  const shares = await validateExpense(groupId, user.id, input);
  let convertedCents = prev.convertedCents;
  let rate = prev.fxRate;
  if (input.amountCents !== prev.amountCents || input.currency !== prev.currency) {
    const c = await convert(input.amountCents, input.currency, groupCurrency);
    convertedCents = c.cents;
    rate = c.rate;
  }
  const [before, after] = await Promise.all([
    loadExpenseSnapshot(expenseId),
    nextExpenseSnapshot(input, shares),
  ]);
  const changes: Change[] = before ? diffExpense(before, after) : [];
  const actionText = `edited "${input.title}" (${fmtMoney(input.amountCents, input.currency)})`;
  const summary = `${user.displayName} ${actionText}`;
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${groupId}::int)`,
    tx`
    WITH share_rows AS (
      SELECT x.user_id, x.share_cents, x.raw_input
      FROM jsonb_to_recordset(${sharesJson(shares, input)}::jsonb)
        AS x(user_id bigint, share_cents bigint, raw_input numeric)
    ),
    existing_members_ok AS (
      SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = ${groupId} AND user_id = ${user.id}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM (
          SELECT e.payer_id AS user_id
          FROM expenses e
          WHERE e.id = ${expenseId} AND e.group_id = ${groupId}
          UNION
          SELECT es.user_id
          FROM expense_shares es
          JOIN expenses e ON e.id = es.expense_id
          WHERE e.id = ${expenseId} AND e.group_id = ${groupId}
        ) existing_participants
        WHERE NOT EXISTS (
          SELECT 1 FROM group_members gm
          WHERE gm.group_id = ${groupId} AND gm.user_id = existing_participants.user_id
        )
      )
    ),
    members_ok AS (
      SELECT 1
      FROM existing_members_ok
      WHERE EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = ${groupId} AND user_id = ${input.payerId}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM share_rows sr
        WHERE NOT EXISTS (
          SELECT 1 FROM group_members gm
          WHERE gm.group_id = ${groupId} AND gm.user_id = sr.user_id
        )
      )
    ),
    upd AS (
      UPDATE expenses SET title = ${input.title}, amount_cents = ${input.amountCents},
        currency = ${input.currency}, converted_cents = ${convertedCents}, fx_rate = ${rate},
        expense_date = ${input.date}, payer_id = ${input.payerId},
        category_id = ${input.categoryId ?? null}, notes = ${input.notes},
        split_method = ${input.splitMethod}, itemized_tax_cents = ${itemizedTaxCents(input)},
        itemized_tip_cents = ${itemizedTipCents(input)}, updated_at = now()
      FROM members_ok
      WHERE id = ${expenseId} AND group_id = ${groupId}
        AND to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = ${input.expectedUpdatedAt}
      RETURNING id
    ),
    del_s AS (
      DELETE FROM expense_shares es
      USING upd
      WHERE es.expense_id = upd.id
      RETURNING 1
    ),
    del_i AS (
      DELETE FROM expense_items ei
      USING upd
      WHERE ei.expense_id = upd.id
      RETURNING 1
    ),
    ins_s AS (
      INSERT INTO expense_shares (expense_id, user_id, share_cents, raw_input)
      SELECT upd.id, x.user_id, x.share_cents, x.raw_input
      FROM upd
      CROSS JOIN (SELECT count(*) FROM del_s) deleted
      CROSS JOIN share_rows x
      RETURNING 1
    ),
    ins_i AS (
      INSERT INTO expense_items (expense_id, name, amount_cents, participant_ids)
      SELECT upd.id, x.name, x.amount_cents,
        ARRAY(SELECT jsonb_array_elements_text(x.participant_ids)::bigint)
      FROM upd
      CROSS JOIN (SELECT count(*) FROM del_i) deleted
      CROSS JOIN jsonb_to_recordset(${itemsJson(input)}::jsonb)
        AS x(name text, amount_cents bigint, participant_ids jsonb)
      RETURNING 1
    ),
    a AS (
      INSERT INTO activity (group_id, actor_id, type, summary, data)
      SELECT ${groupId}, ${user.id}, 'expense.edited', ${summary},
        jsonb_set(${activityData(changes.length ? { changes } : {}, actionText)}::jsonb, '{expenseId}', to_jsonb(upd.id))
      FROM upd
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM upd)::int AS updated`,
  ]);
  if (Number(rows[0]?.updated ?? 0) === 0) badRequest("Expense changed, refresh and try again");
}

export async function updateExpenseByIdWithActivity(
  expenseId: number,
  user: { id: number; displayName: string },
  input: ExpenseInput
) {
  if (!input.expectedUpdatedAt) badRequest("Expense changed, refresh and try again");
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(e.group_id::int) FROM expenses e WHERE e.id = ${expenseId}`,
    tx`
    SELECT e.group_id, g.currency AS group_currency, e.amount_cents, e.currency,
      e.converted_cents, e.fx_rate,
      to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
      EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = e.group_id AND user_id = ${user.id}
      ) AS is_member
    FROM expenses e
    JOIN groups g ON g.id = e.group_id
    WHERE e.id = ${expenseId}`,
  ]);
  if (rows.length === 0) notFound("Expense not found");
  const e = rows[0];
  if (!e.is_member) forbidden();
  if (versionToken(e.updated_at) !== input.expectedUpdatedAt) {
    badRequest("Expense changed, refresh and try again");
  }
  await updateExpenseWithActivity(expenseId, Number(e.group_id), e.group_currency as string, user, input, {
    amountCents: Number(e.amount_cents),
    currency: e.currency as string,
    convertedCents: Number(e.converted_cents),
    fxRate: Number(e.fx_rate),
  });
}

export async function deleteExpenseWithActivity(
  expense: { id: number; groupId: number; title: string; amountCents: number; currency: string; expectedUpdatedAt?: string },
  user: { id: number; displayName: string }
) {
  if (!expense.expectedUpdatedAt) badRequest("Expense changed, refresh and try again");
  const actionText = `deleted "${expense.title}" (${fmtMoney(expense.amountCents, expense.currency)})`;
  const summary = `${user.displayName} ${actionText}`;
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${expense.groupId}::int)`,
    tx`
    WITH existing_members_ok AS (
      SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = ${expense.groupId} AND user_id = ${user.id}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM (
          SELECT e.payer_id AS user_id
          FROM expenses e
          WHERE e.id = ${expense.id} AND e.group_id = ${expense.groupId}
          UNION
          SELECT es.user_id
          FROM expense_shares es
          JOIN expenses e ON e.id = es.expense_id
          WHERE e.id = ${expense.id} AND e.group_id = ${expense.groupId}
        ) existing_participants
        WHERE NOT EXISTS (
          SELECT 1 FROM group_members gm
          WHERE gm.group_id = ${expense.groupId} AND gm.user_id = existing_participants.user_id
        )
      )
    ),
    del AS (
      DELETE FROM expenses
      USING existing_members_ok
      WHERE id = ${expense.id} AND group_id = ${expense.groupId}
        AND to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = ${expense.expectedUpdatedAt}
      RETURNING id
    ),
    a AS (
      INSERT INTO activity (group_id, actor_id, type, summary, data)
      SELECT ${expense.groupId}, ${user.id}, 'expense.deleted', ${summary},
        ${activityData({}, actionText)}::jsonb
      FROM del
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM del)::int AS deleted`,
  ]);
  if (Number(rows[0]?.deleted ?? 0) === 0) badRequest("Expense changed, refresh and try again");
}

export async function insertExpenseComment(
  expenseId: number,
  author: { id: number; displayName: string },
  body: string
): Promise<{ id: number; createdAt: string } | null> {
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(group_id::int) FROM expenses WHERE id = ${expenseId}`,
    tx`
    WITH accessible_expense AS (
      SELECT e.id
      FROM expenses e
      WHERE e.id = ${expenseId}
        AND EXISTS (
          SELECT 1 FROM group_members
          WHERE group_id = e.group_id AND user_id = ${author.id}
        )
    )
    INSERT INTO expense_comments (expense_id, author_id, body)
    SELECT id, ${author.id}, ${body}
    FROM accessible_expense
    RETURNING id, created_at`,
  ]);
  return rows[0] ? { id: Number(rows[0].id), createdAt: rows[0].created_at as string } : null;
}

export async function createRecurringExpenseWithActivity(
  groupId: number,
  user: { id: number; displayName: string },
  body: {
    title: string;
    amountCents: number;
    currency: string;
    payerId: number;
    categoryId?: number | null;
    participantIds: number[];
    notes: string;
    cadence: "weekly" | "monthly";
    startDate: string;
  }
): Promise<number> {
  await validateExpenseActors(groupId, user.id, body);
  // Keep zero-decimal (JPY/KRW) recurring amounts on a whole unit so every
  // materialized expense and its equal-split shares stay whole units.
  const step = currencyStep(body.currency);
  if (step !== 1) body.amountCents = Math.round(body.amountCents / step) * step;
  const summary = `${user.displayName} set up a ${body.cadence} recurring expense "${body.title}"`;
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${groupId}::int)`,
    tx`
    WITH participant_rows AS (
      SELECT x.user_id
      FROM jsonb_to_recordset(${memberIdsJson(body.participantIds)}::jsonb) AS x(user_id bigint)
    ),
    members_ok AS (
      SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = ${groupId} AND user_id = ${body.payerId}
      )
      AND EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = ${groupId} AND user_id = ${user.id}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM participant_rows pr
        WHERE NOT EXISTS (
          SELECT 1 FROM group_members gm
          WHERE gm.group_id = ${groupId} AND gm.user_id = pr.user_id
        )
      )
    ),
    upd AS (
      INSERT INTO recurring_expenses (group_id, title, amount_cents, currency, payer_id, category_id,
        participant_ids, notes, cadence, next_date, anchor_day, created_by)
      SELECT ${groupId}, ${body.title}, ${body.amountCents}, ${body.currency}, ${body.payerId},
        ${body.categoryId ?? null}, ${body.participantIds}, ${body.notes}, ${body.cadence},
        ${body.startDate}, ${Number(body.startDate.slice(8, 10))}, ${user.id}
      FROM members_ok
      RETURNING id
    ),
    a AS (
      INSERT INTO activity (group_id, actor_id, type, summary, data)
      SELECT ${groupId}, ${user.id}, 'recurring.created', ${summary}, '{}'::jsonb
      FROM upd
      RETURNING 1
    )
    SELECT id FROM upd`,
  ]);
  if (!rows[0]) badRequest("Payer and participants must be group members");
  return Number(rows[0].id);
}

export async function updateRecurringExpenseWithActivity(
  id: number,
  groupId: number,
  user: { id: number; displayName: string },
  body: {
    title: string;
    amountCents: number;
    currency: string;
    payerId: number;
    categoryId?: number | null;
    participantIds: number[];
    notes: string;
    cadence: "weekly" | "monthly";
    nextDate: string;
    active: boolean;
    expectedUpdatedAt: string;
  }
) {
  await validateExpenseActors(groupId, user.id, body);
  const step = currencyStep(body.currency);
  if (step !== 1) body.amountCents = Math.round(body.amountCents / step) * step;
  const summary = `${user.displayName} updated the recurring expense "${body.title}"`;
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${groupId}::int)`,
    tx`
    WITH participant_rows AS (
      SELECT x.user_id
      FROM jsonb_to_recordset(${memberIdsJson(body.participantIds)}::jsonb) AS x(user_id bigint)
    ),
    members_ok AS (
      SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = ${groupId} AND user_id = ${body.payerId}
      )
      AND EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = ${groupId} AND user_id = ${user.id}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM participant_rows pr
        WHERE NOT EXISTS (
          SELECT 1 FROM group_members gm
          WHERE gm.group_id = ${groupId} AND gm.user_id = pr.user_id
        )
      )
    ),
    upd AS (
      UPDATE recurring_expenses r SET
        title = ${body.title}, amount_cents = ${body.amountCents}, currency = ${body.currency},
        payer_id = ${body.payerId}, category_id = ${body.categoryId ?? null},
        participant_ids = ${body.participantIds}, notes = ${body.notes}, cadence = ${body.cadence},
        next_date = ${body.nextDate},
        anchor_day = CASE
          WHEN r.next_date = ${body.nextDate}::date AND r.cadence = ${body.cadence} THEN r.anchor_day
          ELSE ${Number(body.nextDate.slice(8, 10))}
        END,
        active = ${body.active},
        updated_at = now()
      FROM members_ok
      WHERE r.id = ${id} AND r.group_id = ${groupId}
        AND to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = ${body.expectedUpdatedAt}
      RETURNING id, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
    ),
    a AS (
      INSERT INTO activity (group_id, actor_id, type, summary, data)
      SELECT ${groupId}, ${user.id}, 'recurring.updated', ${summary}, '{}'::jsonb
      FROM upd
      RETURNING 1
    ),
    stale AS (
      SELECT 1 FROM recurring_expenses
      WHERE id = ${id}
        AND group_id = ${groupId}
        AND to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') <> ${body.expectedUpdatedAt}
    )
    SELECT (SELECT count(*) FROM upd)::int AS updated,
      EXISTS(SELECT 1 FROM stale) AS stale,
      (SELECT updated_at FROM upd) AS updated_at`,
  ]);
  if (Number(rows[0]?.updated ?? 0) === 0 && rows[0]?.stale) badRequest("Recurring expense changed, refresh and try again");
  if (Number(rows[0]?.updated ?? 0) === 0) badRequest("Payer and participants must be group members");
  return { updatedAt: versionToken(rows[0].updated_at) };
}

export async function stopRecurringExpenseWithActivity(
  id: number,
  groupId: number,
  title: string,
  user: { id: number; displayName: string },
  expectedUpdatedAt: string
) {
  const summary = `${user.displayName} stopped the recurring expense "${title}"`;
  const [, rows] = await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${groupId}::int)`,
    tx`
    WITH upd AS (
      UPDATE recurring_expenses SET active = false, updated_at = now()
      WHERE id = ${id} AND group_id = ${groupId}
        AND to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = ${expectedUpdatedAt}
        AND EXISTS (
          SELECT 1 FROM group_members
          WHERE group_id = ${groupId} AND user_id = ${user.id}
        )
      RETURNING id
    ),
    a AS (
      INSERT INTO activity (group_id, actor_id, type, summary, data)
      SELECT ${groupId}, ${user.id}, 'recurring.stopped', ${summary}, '{}'::jsonb
      FROM upd
      RETURNING 1
    ),
    stale AS (
      SELECT 1 FROM recurring_expenses
      WHERE id = ${id}
        AND group_id = ${groupId}
        AND to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') <> ${expectedUpdatedAt}
    )
    SELECT (SELECT count(*) FROM upd)::int AS updated,
      EXISTS(SELECT 1 FROM stale) AS stale`,
  ]);
  if (Number(rows[0]?.updated ?? 0) === 0 && rows[0]?.stale) badRequest("Recurring expense changed, refresh and try again");
  if (Number(rows[0]?.updated ?? 0) === 0) badRequest("You must be a group member to update recurring expenses");
}

function nextOccurrence(current: string, cadence: string, anchorDay: number): string {
  const d = new Date(current + "T00:00:00Z");
  if (cadence === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7);
  } else {
    // Monthly: advance the month and clamp to the anchor day so "rent on the
    // 31st" never drifts (Jan 31 → Feb 28 → Mar 31).
    const month = d.getUTCMonth() + 1;
    const target = new Date(Date.UTC(d.getUTCFullYear(), month, 1));
    const daysInMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(anchorDay, daysInMonth));
    return target.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

async function deactivateRecurringIfSnapshotStillInvalid(
  groupId: number,
  snapshot: {
    id: number;
    currentDate: string;
    title: string;
    amountCents: number;
    currency: string;
    payerId: number;
    categoryId: number | null;
    notes: string;
    cadence: string;
    storedAnchorDay: number | null;
    effectiveAnchorDay: number;
    participantIds: number[];
  }
) {
  await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(${groupId}::int)`,
    tx`
    WITH participant_rows AS (
      SELECT x.user_id
      FROM jsonb_to_recordset(${memberIdsJson(snapshot.participantIds)}::jsonb) AS x(user_id bigint)
    ),
    stale_invalid AS (
      SELECT 1
      FROM recurring_expenses r
      WHERE r.id = ${snapshot.id}
        AND r.group_id = ${groupId}
        AND r.next_date = ${snapshot.currentDate}
        AND r.active
        AND r.title = ${snapshot.title}
        AND r.amount_cents = ${snapshot.amountCents}
        AND r.currency = ${snapshot.currency}
        AND r.payer_id = ${snapshot.payerId}
        AND r.category_id IS NOT DISTINCT FROM ${snapshot.categoryId}
        AND r.notes = ${snapshot.notes}
        AND r.cadence = ${snapshot.cadence}
        AND r.anchor_day IS NOT DISTINCT FROM ${snapshot.storedAnchorDay}
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(r.participant_ids) AS p(user_id)
          FULL JOIN participant_rows pr USING (user_id)
          WHERE p.user_id IS NULL OR pr.user_id IS NULL
        )
        AND (
          NOT EXISTS (
            SELECT 1 FROM group_members
            WHERE group_id = ${groupId} AND user_id = ${snapshot.payerId}
          )
          OR EXISTS (
            SELECT 1
            FROM participant_rows pr
            WHERE NOT EXISTS (
              SELECT 1 FROM group_members gm
              WHERE gm.group_id = ${groupId} AND gm.user_id = pr.user_id
            )
          )
        )
    )
    , paused AS (
      UPDATE recurring_expenses SET active = false, updated_at = now()
      FROM stale_invalid WHERE id = ${snapshot.id} RETURNING created_by
    )
    INSERT INTO activity(group_id, actor_id, type, summary, data)
    SELECT ${groupId}, created_by, 'recurring.paused',
      'SplitWisest paused a recurring expense because a participant is no longer in the group',
      '{"actionText":"paused a recurring expense because a participant is no longer in the group"}'::jsonb
    FROM paused`,
  ]);
}

// The Neon driver parses Postgres DATE columns into JS Date objects (at local
// midnight), so `String(date).slice(0,10)` yields a locale string like
// "Sat Jun 20" and crashes the date math below. Normalize any date value to a
// calendar YYYY-MM-DD using local components, which recover the stored calendar
// date regardless of the server's timezone (the driver parsed it at local
// midnight). A plain "YYYY-MM-DD" string passes through unchanged.
function toYmd(value: unknown): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

// Materialize due recurring expenses for a group, lazily on group view. Each
// period's next_date advance and generated expense insert happen in one SQL
// statement, so process death cannot claim a period without writing it.
export async function materializeRecurring(groupId: number) {
  const due = await sql`
    SELECT r.*, g.currency AS group_currency FROM recurring_expenses r
    JOIN groups g ON g.id = r.group_id
    WHERE r.group_id = ${groupId} AND r.active AND r.next_date <= CURRENT_DATE`;
  for (const r of due) {
    let storedAnchorDay = r.anchor_day === null ? null : Number(r.anchor_day);
    const baseDate = toYmd(r.next_date);
    const effectiveAnchorDay = storedAnchorDay ?? new Date(baseDate + "T00:00:00Z").getUTCDate();
    let current = baseDate;
    for (let i = 0; i < 24; i++) {
      if (new Date(current + "T00:00:00Z").getTime() > Date.now()) break;
      const next = nextOccurrence(current, r.cadence, effectiveAnchorDay);
      const participantIds = (r.participant_ids as number[]).map(Number);
      const participants = participantIds.map((id) => ({ userId: id }));
      const snapshot = {
        id: Number(r.id),
        currentDate: current,
        title: r.title,
        amountCents: Number(r.amount_cents),
        currency: r.currency,
        payerId: Number(r.payer_id),
        categoryId: r.category_id ? Number(r.category_id) : null,
        notes: r.notes,
        cadence: r.cadence as string,
        storedAnchorDay,
        effectiveAnchorDay,
        participantIds,
      };
      try {
        const inserted = await insertExpense(
          groupId,
          r.group_currency,
          Number(r.created_by),
          {
            title: snapshot.title,
            amountCents: snapshot.amountCents,
            currency: snapshot.currency,
            date: current,
            payerId: snapshot.payerId,
            categoryId: snapshot.categoryId,
            notes: snapshot.notes,
            splitMethod: "equal",
            participants,
          },
          {
            activity: { actorName: "SplitWisest", type: "expense.recurring", actionText: `added the recurring expense "${snapshot.title}"` },
            recurring: {
              id: snapshot.id,
              currentDate: current,
              nextDate: next,
              cadence: snapshot.cadence,
              storedAnchorDay: snapshot.storedAnchorDay,
              effectiveAnchorDay: snapshot.effectiveAnchorDay,
            },
          }
        );
        if (inserted === null) {
          // A stale concurrent edit stays untouched. A matching invalid rule pauses with an alert.
          await deactivateRecurringIfSnapshotStillInvalid(groupId, snapshot);
          break;
        }
        storedAnchorDay = effectiveAnchorDay;
      } catch (e) {
        // Log only name+message — never the raw error object, which for a Neon
        // SQL error carries the query text and bound params (matches api.ts).
        console.error(`recurring ${r.id} failed to materialize:`, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        if (e instanceof ApiError && e.status === 400) {
          // Validation failures (e.g. payer left the group) won't heal on
          // retry: deactivate so the group view doesn't re-attempt forever.
          await deactivateRecurringIfSnapshotStillInvalid(groupId, snapshot);
        }
        break;
      }
      current = next;
    }
  }
}

// Expense reads run their access check and data queries as one read-only
// snapshot in a single round trip; rows are returned only after the check passes.
export const EXPENSE_READ = { isolationLevel: "RepeatableRead", readOnly: true } as const;

export function expenseAccessQuery(tx: NeonQueryFunctionInTransaction<false, false>, expenseId: number, userId: number) {
  return tx`
    SELECT e.group_id,
      EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = e.group_id AND gm.user_id = ${userId}) AS is_member
    FROM expenses e WHERE e.id = ${expenseId}`;
}

export function assertExpenseAccess(rows: Record<string, unknown>[]) {
  if (rows.length === 0) notFound("Expense not found");
  if (!rows[0].is_member) forbidden();
}
