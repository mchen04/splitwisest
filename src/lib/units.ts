import { fmtMoney, simplifyDebts, Transfer } from "./money";

export const UNIT_NAME_MAX = 40;

export function normalizeUnitName(input: string): string {
  return (input ?? "").trim().replace(/\s+/g, " ");
}

export function unitNameError(input: string): string | null {
  const name = normalizeUnitName(input);
  if (!name) return "Unit name is required";
  if (name.length > UNIT_NAME_MAX) return `Unit name must be ${UNIT_NAME_MAX} characters or fewer`;
  return null;
}

export type Denomination =
  | { kind: "money"; currency: string }
  | { kind: "unit"; unitId: number; name: string };

export function formatUnitQuantity(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;
  if (fraction === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}

export function formatUnitAmount(cents: number, name: string): string {
  return `${formatUnitQuantity(cents)} ${name}`;
}

export function unitSummaryText(summary: { reconcile: boolean; netCents: number; owesCents: number; owedCents: number }): string {
  const parts = summary.reconcile
    ? [summary.netCents < 0 ? `owes ${formatUnitQuantity(-summary.netCents)}` : summary.netCents > 0 ? `owed ${formatUnitQuantity(summary.netCents)}` : null]
    : [
      summary.owesCents > 0 ? `owes ${formatUnitQuantity(summary.owesCents)}` : null,
      summary.owedCents > 0 ? `owed ${formatUnitQuantity(summary.owedCents)}` : null,
    ];
  const text = parts.filter(Boolean).join(" · ");
  return text || "settled";
}

export function formatDenomination(cents: number, denomination: Denomination): string {
  return denomination.kind === "money"
    ? fmtMoney(cents, denomination.currency)
    : formatUnitAmount(cents, denomination.name);
}

export interface UnitExpenseRow {
  payerId: number;
  amountCents: number;
  shares: { userId: number; shareCents: number }[];
}

export interface UnitSettlementRow {
  payerId: number;
  recipientId: number;
  amountCents: number;
}

export interface UnitObligation {
  from: number;
  to: number;
  amountCents: number;
}

export interface UnitTotalsRow {
  unitId: number;
  userId: number;
  paidCents: number;
  owedCents: number;
  settledOutCents: number;
  settledInCents: number;
}

export interface UnitDirectedRow {
  unitId: number;
  debtorId: number;
  creditorId: number;
  amountCents: number;
}

export interface UnitGross {
  userId: number;
  owesCents: number;
  owedCents: number;
}

export interface UnitSummary {
  unitId: number;
  name: string;
  reconcile: boolean;
  nets: { userId: number; netCents: number }[];
  gross: UnitGross[];
  transfers: Transfer[];
  obligations: UnitObligation[];
}

export interface UnitAggregateData {
  units: { id: number; name: string }[];
  totals: UnitTotalsRow[];
  directed: UnitDirectedRow[];
  people: { userId: number; displayName: string }[];
}

export interface UnitViewerRow {
  unitId: number;
  name: string;
  reconcile: boolean;
  netCents: number;
  owesCents: number;
  owedCents: number;
}

function normalizeDirected(rows: UnitDirectedRow[]): UnitObligation[] {
  const normalized = new Map<string, number>();
  for (const row of rows) {
    if (row.amountCents <= 0) continue;
    const key = `${row.debtorId}:${row.creditorId}`;
    normalized.set(key, (normalized.get(key) ?? 0) + row.amountCents);
  }
  const obligations: UnitObligation[] = [];
  for (const [key, amountCents] of normalized) {
    if (amountCents <= 0) continue;
    const [from, to] = key.split(":").map(Number);
    obligations.push({ from, to, amountCents });
  }
  obligations.sort((a, b) => a.from - b.from || a.to - b.to);
  return obligations;
}

export function computeUnitBalancesFromAggregates(
  memberIds: Iterable<number>,
  unitId: number,
  name: string,
  totals: UnitTotalsRow[],
  directed: UnitDirectedRow[],
  reconcile: boolean
): UnitSummary {
  const ids = new Set(memberIds);
  for (const row of totals) ids.add(row.userId);
  for (const row of directed) {
    ids.add(row.debtorId);
    ids.add(row.creditorId);
  }
  const nets = new Map<number, number>();
  for (const id of ids) nets.set(id, 0);
  if (reconcile) {
    for (const row of totals) {
      nets.set(row.userId, (nets.get(row.userId) ?? 0) +
        row.paidCents - row.owedCents + row.settledOutCents - row.settledInCents);
    }
  }
  const obligations = normalizeDirected(directed);
  const gross = new Map<number, { owesCents: number; owedCents: number }>();
  for (const id of ids) gross.set(id, { owesCents: 0, owedCents: 0 });
  for (const row of obligations) {
    gross.get(row.from)!.owesCents += row.amountCents;
    gross.get(row.to)!.owedCents += row.amountCents;
  }
  if (!reconcile) {
    for (const id of ids) nets.set(id, 0);
    for (const row of obligations) {
      nets.set(row.from, (nets.get(row.from) ?? 0) - row.amountCents);
      nets.set(row.to, (nets.get(row.to) ?? 0) + row.amountCents);
    }
  }
  const netRows = [...nets.entries()]
    .map(([userId, netCents]) => ({ userId, netCents }))
    .sort((a, b) => a.userId - b.userId);
  const grossRows = [...gross.entries()]
    .map(([userId, value]) => ({ userId, ...value }))
    .sort((a, b) => a.userId - b.userId);
  return {
    unitId,
    name,
    reconcile,
    nets: netRows,
    gross: grossRows,
    transfers: reconcile ? simplifyDebts(nets) : [],
    obligations: reconcile ? [] : obligations,
  };
}

function aggregateLedger(
  memberIds: Iterable<number>,
  expenses: UnitExpenseRow[],
  settlements: UnitSettlementRow[]
): { totals: UnitTotalsRow[]; directed: UnitDirectedRow[] } {
  const totals = new Map<number, UnitTotalsRow>();
  const rowFor = (userId: number) => {
    const existing = totals.get(userId);
    if (existing) return existing;
    const row = { unitId: 0, userId, paidCents: 0, owedCents: 0, settledOutCents: 0, settledInCents: 0 };
    totals.set(userId, row);
    return row;
  };
  for (const id of memberIds) rowFor(id);
  const obligations = new Map<string, number>();
  const excess = new Map<string, number>();
  for (const expense of expenses) {
    rowFor(expense.payerId).paidCents += expense.amountCents;
    for (const share of expense.shares) {
      rowFor(share.userId).owedCents += share.shareCents;
      if (share.userId !== expense.payerId) {
        const key = `${share.userId}:${expense.payerId}`;
        obligations.set(key, (obligations.get(key) ?? 0) + share.shareCents);
      }
    }
  }
  for (const settlement of settlements) {
    rowFor(settlement.payerId).settledOutCents += settlement.amountCents;
    rowFor(settlement.recipientId).settledInCents += settlement.amountCents;
    let remaining = settlement.amountCents;
    const reverseKey = `${settlement.recipientId}:${settlement.payerId}`;
    const reverseExcess = Math.min(remaining, excess.get(reverseKey) ?? 0);
    excess.set(reverseKey, (excess.get(reverseKey) ?? 0) - reverseExcess);
    remaining -= reverseExcess;
    const key = `${settlement.payerId}:${settlement.recipientId}`;
    const applied = Math.min(remaining, obligations.get(key) ?? 0);
    obligations.set(key, (obligations.get(key) ?? 0) - applied);
    remaining -= applied;
    if (remaining > 0) excess.set(key, (excess.get(key) ?? 0) + remaining);
  }
  const directed: UnitDirectedRow[] = [];
  for (const [key, amountCents] of obligations) {
    if (amountCents <= 0) continue;
    const [debtorId, creditorId] = key.split(":").map(Number);
    directed.push({ unitId: 0, debtorId, creditorId, amountCents });
  }
  for (const [key, amountCents] of excess) {
    if (amountCents <= 0) continue;
    const [payerId, recipientId] = key.split(":").map(Number);
    directed.push({ unitId: 0, debtorId: recipientId, creditorId: payerId, amountCents });
  }
  return { totals: [...totals.values()], directed };
}

export function computeUnitBalances(
  memberIds: Iterable<number>,
  expenses: UnitExpenseRow[],
  settlements: UnitSettlementRow[],
  reconcile: boolean
): UnitSummary {
  const { totals, directed } = aggregateLedger(memberIds, expenses, settlements);
  return computeUnitBalancesFromAggregates(memberIds, 0, "", totals, directed, reconcile);
}

export function directedObligation(
  obligations: UnitObligation[],
  from: number,
  to: number
): number {
  return obligations.find((row) => row.from === from && row.to === to)?.amountCents ?? 0;
}

export function validateUnitRepayment({
  reconcile,
  obligations,
  payerId,
  recipientId,
  amountCents,
}: {
  reconcile: boolean;
  obligations: UnitObligation[];
  payerId: number;
  recipientId: number;
  amountCents: number;
}): string | null {
  if (reconcile) return null;
  const outstanding = directedObligation(obligations, payerId, recipientId);
  if (amountCents > outstanding) {
    return outstanding === 0
      ? "That person does not owe this unit to the recipient"
      : `That is more than the ${formatUnitQuantity(outstanding)} still owed in this unit`;
  }
  return null;
}

export function parseUnitAggregates(value: unknown): UnitAggregateData {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    units: (Array.isArray(raw.units) ? raw.units : []).map((unit) => {
      const row = unit as Record<string, unknown>;
      return { id: Number(row.id), name: String(row.name) };
    }),
    totals: (Array.isArray(raw.totals) ? raw.totals : []).map((total) => {
      const row = total as Record<string, unknown>;
      return {
        unitId: Number(row.unitId),
        userId: Number(row.userId),
        paidCents: Number(row.paidCents),
        owedCents: Number(row.owedCents),
        settledOutCents: Number(row.settledOutCents),
        settledInCents: Number(row.settledInCents),
      };
    }),
    directed: (Array.isArray(raw.directed) ? raw.directed : []).map((directed) => {
      const row = directed as Record<string, unknown>;
      return {
        unitId: Number(row.unitId),
        debtorId: Number(row.debtorId),
        creditorId: Number(row.creditorId),
        amountCents: Number(row.amountCents),
      };
    }),
    people: (Array.isArray(raw.people) ? raw.people : []).map((person) => {
      const row = person as Record<string, unknown>;
      return { userId: Number(row.userId), displayName: String(row.displayName) };
    }),
  };
}

export function parseUnitViewerRows(value: unknown): UnitViewerRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((unit) => {
    const row = unit as Record<string, unknown>;
    return {
      unitId: Number(row.unitId),
      name: String(row.name),
      reconcile: Boolean(row.reconcile),
      netCents: Number(row.netCents),
      owesCents: Number(row.owesCents),
      owedCents: Number(row.owedCents),
    };
  });
}
