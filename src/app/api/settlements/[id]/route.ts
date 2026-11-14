import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import {
  deleteSettlementWithActivity,
  loadAuthorizedSettlementForMutation,
  settlementFields,
  settlementVersionField,
  updateSettlementWithActivity,
} from "@/lib/settlements";
import { convert } from "@/lib/fx";

type Ctx = { params: Promise<{ id: string }> };

const PatchBody = z.object({ ...settlementFields, ...settlementVersionField });

// Edit a recorded payment's amount, currency, date, or note. Payer and
// recipient stay fixed; converted_cents is recomputed for group settlements.
export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const s = await loadAuthorizedSettlementForMutation(Number((await params).id), user.id);
  const body = PatchBody.parse(await req.json());

  // Only re-snapshot the group-currency converted amount when the amount or
  // currency actually changes (mirrors the expense edit guard). Editing just the
  // note or date must NOT re-convert at today's FX rate — that would retroactively
  // shift a recorded balance, violating "later rate changes never alter recorded
  // balances". Direct settlements are always kept in their own currency.
  let convertedCents = s.convertedCents;
  const reconvert = body.unitId == null && (body.amountCents !== s.amountCents || body.currency !== s.currency);
  if (reconvert) {
    if (s.groupId !== null) {
      const group = await sql`SELECT currency FROM groups WHERE id = ${s.groupId}`;
      convertedCents = group.length > 0
        ? (await convert(body.amountCents, body.currency, group[0].currency)).cents
        : body.amountCents;
    } else {
      convertedCents = body.amountCents;
    }
  }
  const updated = await updateSettlementWithActivity(s, user, body, convertedCents);
  return NextResponse.json({ ok: true, updatedAt: updated.updatedAt });
});

// Delete a recorded payment; balances recompute as if it never happened.
export const DELETE = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await requireUser();
  const s = await loadAuthorizedSettlementForMutation(Number((await params).id), user.id);
  const expectedUpdatedAt = settlementVersionField.expectedUpdatedAt.parse(
    req.nextUrl.searchParams.get("expectedUpdatedAt") ?? ""
  );
  await deleteSettlementWithActivity(s, user, expectedUpdatedAt);
  return NextResponse.json({ ok: true });
});
