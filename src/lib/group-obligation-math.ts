import { z } from "zod";
import { currencyStep } from "./currencies";
import { invalidInput } from "./errors";
import { computeShares } from "./money";
import { VersionToken } from "./versions";

const Side = z.object({
  method: z.enum(["equal", "exact", "percentage", "shares"]),
  participants: z.array(z.object({
    userId: z.number().int().positive(),
    value: z.number().finite().min(0).optional(),
  })).min(1, "Select at least one person"),
}).superRefine((side, ctx) => {
  if (side.method === "equal") return;
  side.participants.forEach((participant, index) => {
    if (participant.value === undefined) ctx.addIssue({
      code: "custom", path: ["participants", index, "value"], message: "Enter a value for each selected person",
    });
  });
});

export const GROUP_BALANCE_RECORD_CONFLICT = "This group balance changed. Close and reopen it before editing";

export const GroupObligationBody = z.object({
  title: z.string().trim().min(1, "Description is required").max(120),
  amountCents: z.number().int().positive("Total must be positive").max(100_000_000_000),
  owes: Side,
  receives: Side,
  expectedUpdatedAt: VersionToken.optional(),
  expectedBalances: z.array(z.tuple([z.number().int().positive(), z.number().int()])).optional(),
});

export type GroupObligationInput = z.infer<typeof GroupObligationBody>;
export type SavedGroupObligation = {
  amountCents: number;
  owes: { method: GroupObligationInput["owes"]["method"]; participants: { userId: number; shareCents: number; value: number | null }[] };
  receives: { method: GroupObligationInput["receives"]["method"]; participants: { userId: number; shareCents: number; value: number | null }[] };
};

export function parseGroupMoney(input: string): number | null {
  const value = input.trim();
  const decimal = /^\d+(?:[.,]\d{1,2})?$/.test(value);
  const grouped = /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(value);
  if (!decimal && !grouped) return null;
  const normalized = grouped ? value.replaceAll(",", "") : value.replace(",", ".");
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents <= 100_000_000_000 ? cents : null;
}

export function computeGroupObligation(input: GroupObligationInput, memberIds: Set<number>, currency: string, saved?: SavedGroupObligation) {
  const step = currencyStep(currency);
  if (input.amountCents % step) invalidInput("Total must be whole units for this currency");
  function side(which: "owes" | "receives") {
    const { method, participants } = input[which];
    const ids = participants.map((p) => p.userId);
    if (new Set(ids).size !== ids.length) invalidInput("Duplicate participants");
    if (ids.some((id) => !memberIds.has(id))) invalidInput("All participants must be group members");
    const prior = saved?.[which];
    const unchanged = saved?.amountCents === input.amountCents && prior?.method === method &&
      prior.participants.length === participants.length && prior.participants.every((p) =>
        participants.some((next) => next.userId === p.userId &&
          (method === "equal" || next.value === p.value)));
    // Existing entries did not store input order. Keep their awarded cents when
    // the allocation did not change; new splits use user ID for stable ties.
    const shares = unchanged && prior
      ? new Map(prior.participants.map((p) => [p.userId, p.shareCents]))
      : computeShares(method, input.amountCents, [...participants].sort((a, b) => a.userId - b.userId), step);
    if ([...shares.values()].reduce((sum, cents) => sum + cents, 0) !== input.amountCents) {
      invalidInput("Allocations must match the total");
    }
    return shares;
  }
  const owes = side("owes");
  const receives = side("receives");
  const net = new Map<number, number>();
  for (const id of memberIds) net.set(id, (receives.get(id) ?? 0) - (owes.get(id) ?? 0));
  return { owes, receives, net };
}

export function groupObligationDelta(nextNet: Map<number, number>, saved?: SavedGroupObligation) {
  const delta = new Map(nextNet);
  if (saved) {
    for (const p of saved.receives.participants) delta.set(p.userId, (delta.get(p.userId) ?? 0) - p.shareCents);
    for (const p of saved.owes.participants) delta.set(p.userId, (delta.get(p.userId) ?? 0) + p.shareCents);
  }
  return delta;
}
