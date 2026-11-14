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

export interface UnitBalanceResult {
  nets: { userId: number; netCents: number }[];
  transfers: Transfer[];
  obligations: UnitObligation[];
}

export function computeUnitBalances(
  memberIds: Iterable<number>,
  expenses: UnitExpenseRow[],
  settlements: UnitSettlementRow[],
  reconcile: boolean
): UnitBalanceResult {
  const nets = new Map<number, number>();
  for (const id of memberIds) nets.set(id, 0);
  const directed = new Map<string, number>();
  const addDirected = (from: number, to: number, amountCents: number) => {
    if (from === to || amountCents === 0) return;
    const key = `${from}:${to}`;
    directed.set(key, (directed.get(key) ?? 0) + amountCents);
  };

  for (const expense of expenses) {
    nets.set(expense.payerId, (nets.get(expense.payerId) ?? 0) + expense.amountCents);
    for (const share of expense.shares) {
      nets.set(share.userId, (nets.get(share.userId) ?? 0) - share.shareCents);
      if (share.userId !== expense.payerId) addDirected(share.userId, expense.payerId, share.shareCents);
    }
  }
  for (const settlement of settlements) {
    nets.set(settlement.payerId, (nets.get(settlement.payerId) ?? 0) + settlement.amountCents);
    nets.set(settlement.recipientId, (nets.get(settlement.recipientId) ?? 0) - settlement.amountCents);
    addDirected(settlement.payerId, settlement.recipientId, -settlement.amountCents);
  }

  const netRows = [...nets.entries()]
    .map(([userId, netCents]) => ({ userId, netCents }))
    .sort((a, b) => a.userId - b.userId);

  if (reconcile) {
    return { nets: netRows, transfers: simplifyDebts(nets), obligations: [] };
  }

  const normalized = new Map<string, number>();
  for (const [key, amountCents] of directed) {
    if (amountCents === 0) continue;
    const [from, to] = key.split(":").map(Number);
    const [a, b, amount] = amountCents > 0 ? [from, to, amountCents] : [to, from, -amountCents];
    const normalizedKey = `${a}:${b}`;
    normalized.set(normalizedKey, (normalized.get(normalizedKey) ?? 0) + amount);
  }
  const obligations: UnitObligation[] = [];
  for (const [key, amountCents] of normalized) {
    if (amountCents <= 0) continue;
    const [from, to] = key.split(":").map(Number);
    obligations.push({ from, to, amountCents });
  }
  obligations.sort((a, b) => a.from - b.from || a.to - b.to);
  return { nets: netRows, transfers: [], obligations };
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

export interface UnitLedgerUnit {
  unitId: number;
  name: string;
  expenses: UnitExpenseRow[];
  settlements: UnitSettlementRow[];
}

export function parseUnitLedger(value: unknown): UnitLedgerUnit[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      unitId: Number(row.unitId),
      name: String(row.name),
      expenses: ((row.expenses ?? []) as Record<string, unknown>[]).map((expense) => ({
        payerId: Number(expense.payerId),
        amountCents: Number(expense.amountCents),
        shares: ((expense.shares ?? []) as Record<string, unknown>[]).map((share) => ({
          userId: Number(share.userId),
          shareCents: Number(share.shareCents),
        })),
      })),
      settlements: ((row.settlements ?? []) as Record<string, unknown>[]).map((settlement) => ({
        payerId: Number(settlement.payerId),
        recipientId: Number(settlement.recipientId),
        amountCents: Number(settlement.amountCents),
      })),
    };
  });
}
