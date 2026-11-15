import { fmtMoney } from "./money";
import { formatUnitAmount } from "./units";

/** Fields a person would care about. Derived values (fx rate, converted amount,
 *  updated_at) are deliberately absent — they move on their own and read as noise. */
export type ChangeField =
  | "amount"
  | "currency"
  | "payer"
  | "participantsRemoved"
  | "participantsAdded"
  | "splitMethod"
  | "splitValues"
  | "date"
  | "category"
  | "title"
  | "notes";

/** Ranked by what a reader looks for first. The feed leads with the highest
 *  ranked change that actually happened and counts the rest. */
const FIELD_ORDER: ChangeField[] = [
  "amount",
  "currency",
  "payer",
  "participantsRemoved",
  "participantsAdded",
  "splitMethod",
  "splitValues",
  "date",
  "category",
  "title",
  "notes",
];

export interface MoneyChange {
  field: "amount";
  fromCents: number;
  toCents: number;
  fromCurrency: string;
  toCurrency: string;
  fromUnitName?: string | null;
  toUnitName?: string | null;
}
export interface TextChange {
  field: "currency" | "payer" | "splitMethod" | "date" | "category" | "title";
  from: string | null;
  to: string | null;
}
export interface PeopleChange {
  field: "participantsRemoved" | "participantsAdded";
  names: string[];
}
export interface BareChange {
  field: "splitValues" | "notes";
  kind?: "added" | "removed" | "changed";
}

export type Change = MoneyChange | TextChange | PeopleChange | BareChange;

export interface ExpenseSnapshot {
  title: string;
  amountCents: number;
  currency: string;
  unitName?: string | null;
  date: string;
  payerName: string;
  categoryName: string | null;
  notes: string;
  splitMethod: string;
  /** One entry per participant. `rawInput` carries the per-person exact amount,
   *  percentage, or share count, so a change to those values is detectable even
   *  when the resulting cents happen to match. */
  shares: { userId: number; name: string; shareCents: number; rawInput: number | null }[];
}

const SPLIT_METHOD_LABELS: Record<string, string> = {
  solo: "solo",
  equal: "equal",
  exact: "exact amounts",
  percentage: "percentages",
  shares: "shares",
  itemized: "itemized bill",
};

export function splitMethodLabel(method: string): string {
  return SPLIT_METHOD_LABELS[method] ?? method;
}

/** "2026-08-03" -> "Aug 3". Falls back to the raw value if it is not a plain date. */
export function shortDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(m[2]) - 1];
  if (!month) return value;
  return `${month} ${Number(m[3])}`;
}

/** Methods where a person types the per-person number themselves. */
const MANUAL_SPLIT_METHODS = new Set(["exact", "percentage", "shares", "itemized"]);

function sameShares(a: ExpenseSnapshot["shares"], b: ExpenseSnapshot["shares"]): boolean {
  const key = (s: ExpenseSnapshot["shares"][number]) => `${s.userId}:${s.shareCents}:${s.rawInput ?? ""}`;
  const as = a.map(key).sort();
  const bs = b.map(key).sort();
  return as.length === bs.length && as.every((v, i) => v === bs[i]);
}

function namesFor(shares: ExpenseSnapshot["shares"], ids: number[]): string[] {
  return ids
    .map((id) => shares.find((s) => s.userId === id)?.name)
    .filter((n): n is string => Boolean(n));
}

/** Compares two snapshots and returns only the fields that actually moved. */
export function diffExpense(prev: ExpenseSnapshot, next: ExpenseSnapshot): Change[] {
  const changes: Change[] = [];

  const prevUnit = prev.unitName ?? null;
  const nextUnit = next.unitName ?? null;
  if (prev.amountCents !== next.amountCents || prevUnit !== nextUnit) {
    changes.push({
      field: "amount",
      fromCents: prev.amountCents,
      toCents: next.amountCents,
      fromCurrency: prev.currency,
      toCurrency: next.currency,
      fromUnitName: prevUnit,
      toUnitName: nextUnit,
    });
  }
  if (prev.currency !== next.currency && prevUnit === nextUnit) {
    changes.push({ field: "currency", from: prev.currency, to: next.currency });
  }
  if (prev.payerName !== next.payerName) {
    changes.push({ field: "payer", from: prev.payerName, to: next.payerName });
  }

  const prevIds = prev.shares.map((s) => s.userId);
  const nextIds = next.shares.map((s) => s.userId);
  const removed = prevIds.filter((id) => !nextIds.includes(id));
  const added = nextIds.filter((id) => !prevIds.includes(id));
  if (removed.length) changes.push({ field: "participantsRemoved", names: namesFor(prev.shares, removed) });
  if (added.length) changes.push({ field: "participantsAdded", names: namesFor(next.shares, added) });

  if (prev.splitMethod !== next.splitMethod) {
    changes.push({
      field: "splitMethod",
      from: splitMethodLabel(prev.splitMethod),
      to: splitMethodLabel(next.splitMethod),
    });
  }
  // Per-person values are only worth reporting when a person set them. Under an
  // equal or solo split they fall out of the total and the membership, so they
  // would just restate the amount change. A membership change explains itself.
  if (
    !removed.length &&
    !added.length &&
    MANUAL_SPLIT_METHODS.has(next.splitMethod) &&
    !sameShares(prev.shares, next.shares)
  ) {
    changes.push({ field: "splitValues" });
  }

  if (prev.date !== next.date) {
    changes.push({ field: "date", from: prev.date, to: next.date });
  }
  if ((prev.categoryName ?? null) !== (next.categoryName ?? null)) {
    changes.push({ field: "category", from: prev.categoryName, to: next.categoryName });
  }
  if (prev.title !== next.title) {
    changes.push({ field: "title", from: prev.title, to: next.title });
  }
  if (prev.notes !== next.notes) {
    const kind = !prev.notes ? "added" : !next.notes ? "removed" : "changed";
    changes.push({ field: "notes", kind });
  }

  return sortChanges(changes);
}

export function sortChanges(changes: Change[]): Change[] {
  return [...changes].sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field));
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "someone";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** One change as a sentence fragment that follows the actor's name. */
export function describeChange(change: Change): string {
  switch (change.field) {
    case "amount":
      return `changed the amount from ${change.fromUnitName
        ? formatUnitAmount(change.fromCents, change.fromUnitName)
        : fmtMoney(change.fromCents, change.fromCurrency)} to ${change.toUnitName
        ? formatUnitAmount(change.toCents, change.toUnitName)
        : fmtMoney(change.toCents, change.toCurrency)}`;
    case "currency":
      return `changed the currency from ${change.from} to ${change.to}`;
    case "payer":
      return `changed who paid from ${change.from} to ${change.to}`;
    case "participantsRemoved":
      return `removed ${joinNames(change.names)} from the split`;
    case "participantsAdded":
      return `added ${joinNames(change.names)} to the split`;
    case "splitMethod":
      return `switched the split from ${change.from} to ${change.to}`;
    case "splitValues":
      return "changed how much each person owes";
    case "date":
      return `moved the date from ${shortDate(change.from ?? "")} to ${shortDate(change.to ?? "")}`;
    case "category":
      if (!change.from) return `set the category to ${change.to}`;
      if (!change.to) return "cleared the category";
      return `changed the category from ${change.from} to ${change.to}`;
    case "title":
      return `renamed it from "${change.from}" to "${change.to}"`;
    case "notes":
      if (change.kind === "added") return "added a note";
      if (change.kind === "removed") return "removed the note";
      return "changed the note";
  }
}

/** A short noun phrase for the lead change, used when counting the rest. */
function shortLabel(change: Change): string {
  switch (change.field) {
    case "amount":
      return "changed the amount";
    case "currency":
      return "changed the currency";
    case "payer":
      return "changed who paid";
    case "participantsRemoved":
      return `removed ${joinNames(change.names)} from the split`;
    case "participantsAdded":
      return `added ${joinNames(change.names)} to the split`;
    case "splitMethod":
      return "switched the split";
    case "splitValues":
      return "changed the split";
    case "date":
      return "moved the date";
    case "category":
      return "changed the category";
    case "title":
      return "renamed it";
    case "notes":
      return "changed the note";
  }
}

/**
 * The feed's single line: the most important change, then a count of the rest.
 * Never wraps to a paragraph and never truncates mid-sentence.
 */
export function feedLine(changes: Change[]): string | null {
  const sorted = sortChanges(changes);
  const lead = sorted[0];
  if (!lead) return null;
  const rest = sorted.length - 1;
  if (rest === 0) return describeChange(lead);
  return `${shortLabel(lead)} and ${rest} other thing${rest === 1 ? "" : "s"}`;
}
