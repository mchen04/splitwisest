import { invalidInput } from "./errors";

// All money is handled as integer cents. Splits must sum exactly to the total;
// remainders from integer division are distributed one cent at a time to the
// earliest participants so nothing is ever lost or invented.

export type SplitMethod = "equal" | "exact" | "percentage" | "shares" | "itemized";

export interface SplitInput {
  userId: number;
  // meaning depends on method: exact = cents, percentage = percent (0-100), shares = share count
  value?: number;
}

// `step` is the currency's smallest representable unit in stored cents (1 for
// 2-decimal currencies, 100 for zero-decimal JPY/KRW). Splits distribute whole
// `step` increments so a JPY split never produces an unpayable sub-yen share.
// step defaults to 1, leaving all 2-decimal behavior unchanged.
export function splitEqual(totalCents: number, userIds: number[], step = 1): Map<number, number> {
  if (userIds.length === 0) invalidInput("No participants");
  const units = Math.round(totalCents / step);
  const base = Math.floor(units / userIds.length);
  let remainder = units - base * userIds.length;
  const out = new Map<number, number>();
  for (const id of userIds) {
    out.set(id, (base + (remainder > 0 ? 1 : 0)) * step);
    if (remainder > 0) remainder--;
  }
  return out;
}

export function splitExact(totalCents: number, inputs: SplitInput[], step = 1): Map<number, number> {
  if (inputs.length === 0) throw new Error("No participants");
  const out = new Map<number, number>();
  let sum = 0;
  for (const { userId, value } of inputs) {
    const cents = value ?? 0;
    // Exact amounts must be whole representable units — reject fractional cents
    // (previously silently rounded, which could flip the add-up check) and, for
    // zero-decimal currencies, reject sub-unit amounts.
    if (!Number.isInteger(cents) || cents % step !== 0) {
      invalidInput(step === 1 ? "Exact amounts must be whole cents" : "Exact amounts must be whole units for this currency");
    }
    if (cents < 0) invalidInput("Negative share");
    out.set(userId, cents);
    sum += cents;
  }
  if (sum !== totalCents) {
    invalidInput(`Exact amounts must add up to the total (got ${sum}, expected ${totalCents})`);
  }
  return out;
}

export function splitPercentage(totalCents: number, inputs: SplitInput[], step = 1): Map<number, number> {
  if (inputs.length === 0) invalidInput("No participants");
  if (inputs.some((i) => (i.value ?? 0) < 0)) invalidInput("Percentages must be positive");
  const { weights, scale } = integerWeights(inputs.map((i) => i.value ?? 0));
  if (weights.reduce((sum, weight) => sum + weight, BigInt(0)) !== BigInt(100) * scale) {
    invalidInput("Percentages must add up to 100");
  }
  return distributeProportional(
    totalCents,
    inputs.map((i) => ({ userId: i.userId, weight: i.value ?? 0 })),
    step
  );
}

export function splitShares(totalCents: number, inputs: SplitInput[], step = 1): Map<number, number> {
  if (inputs.length === 0) invalidInput("No participants");
  if (inputs.some((i) => (i.value ?? 0) < 0)) invalidInput("Shares must be positive");
  const totalShares = inputs.reduce((s, i) => s + (i.value ?? 0), 0);
  if (totalShares <= 0) invalidInput("Total shares must be positive");
  return distributeProportional(
    totalCents,
    inputs.map((i) => ({ userId: i.userId, weight: i.value ?? 0 })),
    step
  );
}

// Largest-remainder method: floor each proportional share (in whole `step`
// units), then hand out the leftover units to the largest fractional remainders.
function integerWeights(values: number[]) {
  const decimals = values.map((value) => {
    if (!Number.isFinite(value) || value < 0) invalidInput("Weights must be finite and nonnegative");
    const [coefficient, exponent = "0"] = String(value).split("e");
    const [whole, fraction = ""] = coefficient.split(".");
    return { digits: BigInt(whole + fraction), places: fraction.length - Number(exponent) };
  });
  const places = Math.max(0, ...decimals.map((d) => d.places));
  const power = (exponent: number) => BigInt(10) ** BigInt(exponent);
  return { weights: decimals.map((d) => d.digits * power(places - d.places)), scale: power(places) };
}

function distributeProportional(
  totalCents: number,
  weights: { userId: number; weight: number }[],
  step = 1
): Map<number, number> {
  const integers = integerWeights(weights.map((w) => w.weight)).weights;
  const totalWeight = integers.reduce((s, w) => s + w, BigInt(0));
  if (totalWeight <= BigInt(0)) invalidInput("Total weight must be positive");
  const totalUnits = BigInt(Math.round(totalCents / step));
  const rows = weights.map(({ userId }, index) => {
    const numerator = totalUnits * integers[index];
    return { userId, floor: numerator / totalWeight, frac: numerator % totalWeight };
  });
  let leftover = totalUnits - rows.reduce((s, r) => s + r.floor, BigInt(0));
  const byFrac = [...rows].sort((a, b) => a.frac > b.frac ? -1 : a.frac < b.frac ? 1 : 0);
  const bonus = new Map<number, number>();
  for (const r of byFrac) {
    bonus.set(r.userId, leftover > BigInt(0) ? 1 : 0);
    if (leftover > BigInt(0)) leftover--;
  }
  const out = new Map<number, number>();
  for (const r of rows) out.set(r.userId, (Number(r.floor) + (bonus.get(r.userId) ?? 0)) * step);
  return out;
}

export function computeShares(
  method: SplitMethod,
  totalCents: number,
  inputs: SplitInput[],
  step = 1
): Map<number, number> {
  switch (method) {
    case "equal":
      return splitEqual(totalCents, inputs.map((i) => i.userId), step);
    case "exact":
      return splitExact(totalCents, inputs, step);
    case "percentage":
      return splitPercentage(totalCents, inputs, step);
    case "shares":
      return splitShares(totalCents, inputs, step);
    case "itemized":
      // itemized expenses compute shares from items; handled by caller
      invalidInput("Itemized shares are computed from items");
  }
}

// Items: each item's cost is split equally among its participants; a user's
// total share is the sum across items. Item amounts must sum to the total.
// `step` is the currency's smallest representable unit in stored cents (100 for
// zero-decimal JPY/KRW): item amounts and tax/tip must be whole `step` units and
// every per-item equal split distributes whole units, so an itemized JPY expense
// can never produce an unpayable sub-yen share (mirrors the non-itemized path).
export function computeItemizedShares(
  totalCents: number,
  items: { amountCents: number; participantIds: number[] }[],
  adjustments: { taxCents?: number; tipCents?: number } = {},
  step = 1
): Map<number, number> {
  const itemSum = items.reduce((s, i) => s + i.amountCents, 0);
  const taxCents = Math.round(adjustments.taxCents ?? 0);
  const tipCents = Math.round(adjustments.tipCents ?? 0);
  const adjustmentTotal = taxCents + tipCents;
  if (step !== 1) {
    for (const item of items) {
      if (item.amountCents % step !== 0) invalidInput("Item amounts must be whole units for this currency");
    }
    if (taxCents % step !== 0 || tipCents % step !== 0) {
      invalidInput("Tax and tip must be whole units for this currency");
    }
  }
  if (itemSum + adjustmentTotal !== totalCents) {
    invalidInput(`Item amounts plus tax and tip must add up to the total (got ${itemSum + adjustmentTotal}, expected ${totalCents})`);
  }
  const out = new Map<number, number>();
  for (const item of items) {
    if (item.participantIds.length === 0) invalidInput("Each item needs at least one participant");
    if (new Set(item.participantIds).size !== item.participantIds.length) {
      invalidInput("Duplicate item participants");
    }
    const split = splitEqual(item.amountCents, item.participantIds, step);
    for (const [uid, cents] of split) out.set(uid, (out.get(uid) ?? 0) + cents);
  }
  if (adjustmentTotal > 0) {
    if (itemSum <= 0) invalidInput("Item subtotal must be positive when tax or tip is added");
    const adjustmentShares = distributeProportional(
      adjustmentTotal,
      [...out.entries()].map(([userId, weight]) => ({ userId, weight })),
      step
    );
    for (const [uid, cents] of adjustmentShares) out.set(uid, (out.get(uid) ?? 0) + cents);
  }
  return out;
}

export interface Transfer {
  from: number;
  to: number;
  amountCents: number;
}

function greedySettlementPlan(netBalances: Map<number, number>): Transfer[] {
  const creditors: { id: number; amt: number }[] = [];
  const debtors: { id: number; amt: number }[] = [];
  for (const [id, net] of netBalances) {
    if (net > 0) creditors.push({ id, amt: net });
    else if (net < 0) debtors.push({ id, amt: -net });
  }
  creditors.sort((a, b) => b.amt - a.amt || a.id - b.id);
  debtors.sort((a, b) => b.amt - a.amt || a.id - b.id);
  const transfers: Transfer[] = [];
  let ci = 0;
  let di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const pay = Math.min(creditors[ci].amt, debtors[di].amt);
    if (pay > 0) transfers.push({ from: debtors[di].id, to: creditors[ci].id, amountCents: pay });
    creditors[ci].amt -= pay;
    debtors[di].amt -= pay;
    if (creditors[ci].amt === 0) ci++;
    if (debtors[di].amt === 0) di++;
  }
  return transfers;
}

const EXACT_SETTLEMENT_LIMIT = 18;

// Split balances into the largest possible number of zero-sum sets. Each set
// needs members - 1 payments, so this produces the fewest total payments.
export function simplifyDebts(netBalances: Map<number, number>): Transfer[] {
  const balances = [...netBalances]
    .filter(([, net]) => net !== 0)
    .sort(([a], [b]) => a - b)
    .map(([id, net]) => ({ id, net }));
  if (balances.length <= 1) return [];
  if (balances.length > EXACT_SETTLEMENT_LIMIT) return greedySettlementPlan(netBalances);

  const stateCount = 1 << balances.length;
  const sums = new Float64Array(stateCount);
  for (let mask = 1; mask < stateCount; mask++) {
    const bit = mask & -mask;
    const index = 31 - Math.clz32(bit);
    sums[mask] = sums[mask ^ bit] + balances[index].net;
  }

  const groups = new Int8Array(stateCount);
  const previous = new Int32Array(stateCount);
  const added = new Int8Array(stateCount);
  groups.fill(-1);
  previous.fill(-1);
  added.fill(-1);
  groups[0] = 0;

  for (let mask = 0; mask < stateCount; mask++) {
    if (groups[mask] < 0) continue;
    for (let index = 0; index < balances.length; index++) {
      const bit = 1 << index;
      if (mask & bit) continue;
      const next = mask | bit;
      const score = groups[mask] + (sums[next] === 0 ? 1 : 0);
      if (score <= groups[next]) continue;
      groups[next] = score;
      previous[next] = mask;
      added[next] = index;
    }
  }

  const order: number[] = [];
  for (let mask = stateCount - 1; mask !== 0; mask = previous[mask]) {
    order.push(added[mask]);
  }
  order.reverse();

  const transfers: Transfer[] = [];
  let group = new Map<number, number>();
  let sum = 0;
  for (const index of order) {
    const balance = balances[index];
    group.set(balance.id, balance.net);
    sum += balance.net;
    if (sum !== 0) continue;
    transfers.push(...greedySettlementPlan(group));
    group = new Map();
  }
  return transfers;
}

export function fmtMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

// Normalize a typed money string to cents, or null if it isn't a positive amount.
// Treats a comma followed by 1-2 trailing digits as a decimal separator
// ("12,34" → 1234 cents) so comma-decimal locales don't silently truncate via
// raw parseFloat ("12,34" → 12); other commas are thousands separators.
export function amountInputToCents(input: string): number | null {
  const t = (input ?? "").trim();
  const normalized = /,\d{1,2}$/.test(t) && !t.includes(".") ? t.replace(/,(\d{1,2})$/, ".$1") : t;
  const cleaned = normalized.replace(/[^0-9.]/g, "");
  if (!cleaned || !/^\d*\.?\d*$/.test(cleaned)) return null;
  const cents = Math.round(parseFloat(cleaned) * 100);
  if (!Number.isFinite(cents) || cents <= 0 || cents > 100_000_000_000) return null;
  return cents;
}
