"use client";

import { readDraft } from "@/lib/drafts";
import type { Method, ItemRow } from "./expense-splits";

export const EXPENSE_DRAFT_KEY = "expense";

export interface ExpenseFields {
  title: string;
  amount: string;
  currency: string;
  date: string;
  payerId: number;
  categoryId: number | "";
  notes: string;
  showDetails: boolean;
  method: Method;
  selected: number[];
  values: Record<number, string>;
  items: ItemRow[];
  taxEnabled: boolean;
  taxRate: string;
  tipEnabled: boolean;
  tipRate: string;
}

export interface ExpenseDraft {
  mode: "new" | "edit";
  groupId: number;
  expenseId?: number;
  updatedAt?: string;
  fields: ExpenseFields;
}

export function readExpenseDraft(meId: number): ExpenseDraft | null {
  return readDraft<ExpenseDraft>(meId, EXPENSE_DRAFT_KEY);
}

