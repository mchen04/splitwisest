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
});

export const GroupObligationBody = z.object({
  title: z.string().trim().min(1, "Description is required").max(120),
  amountCents: z.number().int().positive("Total must be positive").max(100_000_000_000),
  owes: Side,
  receives: Side,
  expectedUpdatedAt: VersionToken.optional(),
});

export type GroupObligationInput = z.infer<typeof GroupObligationBody>;

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

export function computeGroupObligation(input: GroupObligationInput, memberIds: Set<number>, currency: string) {
  const step = currencyStep(currency);
  if (input.amountCents % step) invalidInput("Total must be whole units for this currency");
  function side(which: "owes" | "receives") {
    const { method, participants } = input[which];
    const ids = participants.map((p) => p.userId);
    if (new Set(ids).size !== ids.length) invalidInput("Duplicate participants");
    if (ids.some((id) => !memberIds.has(id))) invalidInput("All participants must be group members");
    const shares = computeShares(method, input.amountCents, participants, step);
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
