"use client";

import { useEffect, useMemo, useState } from "react";
import { Paperclip, Plus, Check, AlertCircle, Users, ChevronDown, X } from "lucide-react";
import {
  api, ApiClientError, fmtMoney, todayStr, CURRENCIES, amountInputToCents, useApiData, refreshExpenseDetails,
} from "@/lib/client";
import { rememberExpenseGroup } from "@/lib/last-group";
import { ActionError, Button, Field, Input, Select, Textarea, Modal, ErrorNote, toast, confirmAction, radioGroupKeyDown, radioTabIndex } from "./ui";
import { ParticipantSplit, ItemizedSplit, Method, METHOD_LABELS, ItemRow } from "./expense-splits";

const CALIFORNIA_TAX_RATE = "7.25";

// Comma-decimal aware (so a "12,34" locale entry isn't truncated to 12 by parseFloat).
function amountToCents(value: string): number {
  return amountInputToCents(value) ?? 0;
}

export interface Member {
  id: number;
  displayName: string;
}

interface Category {
  id: number;
  name: string;
  custom: boolean;
}

interface ExistingExpense {
  id: number;
  title: string;
  amountCents: number;
  currency: string;
  date: string;
  payerId: number;
  categoryId: number | null;
  notes: string;
  splitMethod: string;
  updatedAt: string;
  itemizedTaxCents?: number;
  itemizedTipCents?: number;
  shares: { userId: number; shareCents: number; rawInput: number | null }[];
  items: { name: string; amountCents: number; participantIds: number[] }[];
  attachments: { id: number; filename: string; mime: string }[];
}

function adjustmentRate(adjustmentCents: number, subtotalCents: number, fallback: string): string {
  if (adjustmentCents <= 0 || subtotalCents <= 0) return fallback;
  return ((adjustmentCents * 100) / subtotalCents).toFixed(8).replace(/\.?0+$/, "");
}

export function ExpenseForm({
  groupId,
  groupName,
  groupCurrency,
  members,
  meId,
  existing,
  open,
  onClose,
  onSaved,
  onCreated,
  onCategoryAdded,
  groupOptions,
  selectedGroupId,
  groupSwitching = false,
  groupSwitchError = null,
  onRetryGroupSwitch,
  onGroupChange,
}: {
  groupId: number;
  groupName: string;
  groupCurrency: string;
  members: Member[];
  meId: number;
  existing?: ExistingExpense | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** Called after a new expense saves; replaces the default confirmation. */
  onCreated?: (info: { id: number; title: string }) => void;
  onCategoryAdded?: () => void;
  /** When present, the group is a choice inside the form (Add from outside a group). */
  groupOptions?: { id: number; name: string; currency: string }[];
  selectedGroupId?: number;
  /** True while the picked group's members load; payer and split still show `groupId`'s members. */
  groupSwitching?: boolean;
  /** Why the picked group could not load; the form stays on `groupId` and keeps what was typed. */
  groupSwitchError?: string | null;
  onRetryGroupSwitch?: () => void;
  onGroupChange?: (groupId: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [date, setDate] = useState(todayStr());
  const [payerId, setPayerId] = useState(meId);
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [notes, setNotes] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const defaultSoloId = members.find((member) => member.id !== meId)?.id ?? meId;
  const [method, setMethod] = useState<Method>("solo");
  const [selected, setSelected] = useState<Set<number>>(new Set([defaultSoloId]));
  const [values, setValues] = useState<Record<number, string>>({});
  const [items, setItems] = useState<ItemRow[]>([]);
  const [taxEnabled, setTaxEnabled] = useState(false);
  const [taxRate, setTaxRate] = useState(CALIFORNIA_TAX_RATE);
  const [tipEnabled, setTipEnabled] = useState(false);
  const [tipRate, setTipRate] = useState("20");
  const {
    data: categoriesData,
    error: categoriesError,
    reload: reloadCategories,
  } = useApiData<{ categories: Category[] }>("/api/categories", 0, { sync: false });
  const [addedCategories, setAddedCategories] = useState<Category[]>([]);
  const baseCategories = categoriesData?.categories ?? [];
  const categories = [
    ...baseCategories,
    ...addedCategories.filter((added) => !baseCategories.some((base) => base.id === added.id)),
  ];
  const [newCategory, setNewCategory] = useState("");
  const [addingCat, setAddingCat] = useState(false);
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [savedAttachments, setSavedAttachments] = useState<ExistingExpense["attachments"]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Reset the form when opening or switching the edited expense.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);
    setBusy(false);
    setFiles([]);
    setAddingCat(false);
    setCategoryBusy(false);
    setNewCategory("");
    setSavedAttachments(existing?.attachments ?? []);
    if (existing) {
      setTitle(existing.title);
      setAmount((existing.amountCents / 100).toFixed(2));
      setCurrency(existing.currency);
      setDate(String(existing.date).slice(0, 10));
      setPayerId(existing.payerId);
      setCategoryId(existing.categoryId ?? "");
      setNotes(existing.notes);
      setShowDetails(Boolean(existing.notes || existing.attachments.length));
      setMethod(existing.splitMethod === "equal" && existing.shares.length === 1 ? "solo" : existing.splitMethod as Method);
      setSelected(new Set(existing.shares.map((s) => s.userId)));
      const vals: Record<number, string> = {};
      for (const s of existing.shares) {
        if (existing.splitMethod === "exact") vals[s.userId] = (s.shareCents / 100).toFixed(2);
        else if (s.rawInput !== null) vals[s.userId] = String(s.rawInput);
      }
      setValues(vals);
      const savedItemSubtotal = existing.items.reduce((sum, item) => sum + item.amountCents, 0);
      const savedTaxCents = existing.itemizedTaxCents ?? 0;
      const savedTipCents = existing.itemizedTipCents ?? 0;
      setTaxEnabled(savedTaxCents > 0);
      setTaxRate(adjustmentRate(savedTaxCents, savedItemSubtotal, CALIFORNIA_TAX_RATE));
      setTipEnabled(savedTipCents > 0);
      setTipRate(adjustmentRate(savedTipCents, savedItemSubtotal, "20"));
      setItems(
        existing.items.map((i) => ({
          name: i.name,
          amount: (i.amountCents / 100).toFixed(2),
          participantIds: i.participantIds,
        }))
      );
    } else {
      setTitle("");
      setAmount("");
      setCurrency(groupCurrency);
      setDate(todayStr());
      setPayerId(meId);
      setCategoryId("");
      setNotes("");
      setShowDetails(false);
      setMethod("solo");
      setSelected(new Set([defaultSoloId]));
      setValues({});
      setItems([]);
      setTaxEnabled(false);
      setTaxRate(CALIFORNIA_TAX_RATE);
      setTipEnabled(false);
      setTipRate("20");
    }
    // Reset only when the modal opens or the edited expense changes — background
    // sync replaces members/categories references and must not wipe live input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);

  useEffect(() => {
    if (!open || existing) return;
    // A different group has different members and currency. Keep what was
    // typed; restart the payer and split for the new members.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCurrency(groupCurrency);
    setPayerId(meId);
    setMethod("solo");
    setSelected(new Set([defaultSoloId]));
    setValues({});
    setItems([]);
    // Runs only when the group itself changes; member list refreshes must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  const amountCents = useMemo(() => {
    return amountToCents(amount);
  }, [amount]);

  const itemSubtotalCents = useMemo(
    () => items.reduce((s, i) => s + amountToCents(i.amount), 0),
    [items]
  );
  const taxCents = useMemo(() => {
    if (!taxEnabled || itemSubtotalCents <= 0) return 0;
    return Math.round(itemSubtotalCents * (Math.max(parseFloat(taxRate || "0") || 0, 0) / 100));
  }, [taxEnabled, itemSubtotalCents, taxRate]);
  const tipCents = useMemo(() => {
    if (!tipEnabled || itemSubtotalCents <= 0) return 0;
    return Math.round(itemSubtotalCents * (Math.max(parseFloat(tipRate || "0") || 0, 0) / 100));
  }, [tipEnabled, itemSubtotalCents, tipRate]);
  const itemizedTotalCents = itemSubtotalCents + taxCents + tipCents;
  const effectiveAmountCents = method === "itemized" && itemSubtotalCents > 0 ? itemizedTotalCents : amountCents;
  const displayedAmount =
    method === "itemized" && itemSubtotalCents > 0 ? (itemizedTotalCents / 100).toFixed(2) : amount;

  const participantList = members.filter((m) => selected.has(m.id));
  // Live validation feedback for split inputs
  const splitStatus = useMemo(() => {
    if (method === "solo" || method === "equal" || effectiveAmountCents === 0) return null;
    if (method === "exact") {
      const sum = participantList.reduce((s, m) => s + (amountInputToCents(values[m.id] || "0") ?? 0), 0);
      const diff = amountCents - sum;
      return diff === 0
        ? { ok: true, msg: "Amounts match the total" }
        : { ok: false, msg: `${fmtMoney(Math.abs(diff), currency)} ${diff > 0 ? "left to assign" : "over the total"}` };
    }
    if (method === "percentage") {
      const sum = participantList.reduce((s, m) => s + (parseFloat(values[m.id] || "0") || 0), 0);
      return Math.abs(sum - 100) < 0.001
        ? { ok: true, msg: "Adds up to 100%" }
        : { ok: false, msg: `Currently ${sum.toFixed(1)}% — must equal 100%` };
    }
    if (method === "shares") {
      const sum = participantList.reduce((s, m) => s + (parseFloat(values[m.id] || "0") || 0), 0);
      return sum > 0 ? { ok: true, msg: `${sum} total shares` } : { ok: false, msg: "Add at least one share" };
    }
    if (method === "itemized") {
      const sum = itemSubtotalCents + taxCents + tipCents;
      const diff = effectiveAmountCents - sum;
      return diff === 0
        ? { ok: true, msg: `Items, tax, and tip total ${fmtMoney(sum, currency)}` }
        : { ok: false, msg: `Items, tax, and tip ${diff > 0 ? "under" : "over"} by ${fmtMoney(Math.abs(diff), currency)}` };
    }
    return null;
  }, [method, amountCents, participantList, values, itemSubtotalCents, taxCents, tipCents, effectiveAmountCents, currency]);

  function toggleMember(id: number) {
    if (method === "solo") {
      setSelected(new Set([id]));
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addCategory() {
    if (!newCategory.trim() || categoryBusy) return;
    setCategoryBusy(true);
    try {
      const c = await api<Category>("/api/categories", { body: { name: newCategory.trim() } });
      setAddedCategories((current) => [...current, c]);
      setCategoryId(c.id);
      setNewCategory("");
      setAddingCat(false);
      requestAnimationFrame(() => document.getElementById("expense-category")?.focus());
      reloadCategories();
      onCategoryAdded?.();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not add category");
    } finally {
      setCategoryBusy(false);
    }
  }

  // Normalize the per-participant payload: itemized derives participants from
  // item rows; exact carries cents; percentage/shares carry the raw weight.
  function buildParticipants(): { userId: number; value?: number }[] {
    if (method === "itemized") {
      return [...new Set(items.flatMap((i) => i.participantIds))].map((userId) => ({ userId }));
    }
    return participantList.map((m) => ({
      userId: m.id,
      value:
        method === "solo" || method === "equal"
          ? undefined
          : method === "exact"
            ? amountInputToCents(values[m.id] || "0") ?? 0
            : parseFloat(values[m.id] || "0") || 0,
    }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (effectiveAmountCents <= 0) {
      setError("Enter a positive amount");
      document.getElementById("expense-amount")?.focus();
      return;
    }
    if (method !== "itemized" && participantList.length === 0) return setError("Pick at least one participant");

    const participants = buildParticipants();
    if (participants.length === 0) return setError("Each item needs participants");

    const body = {
      title: title.trim(),
      amountCents: effectiveAmountCents,
      currency,
      date,
      payerId,
      categoryId: categoryId === "" ? null : categoryId,
      notes,
      splitMethod: method === "solo" ? "equal" : method,
      participants,
      items:
        method === "itemized"
          ? items.map((i) => ({
              name: i.name.trim() || "Item",
              amountCents: amountInputToCents(i.amount || "0") ?? 0,
              participantIds: i.participantIds,
            }))
          : undefined,
      itemizedTaxCents: method === "itemized" ? taxCents : undefined,
      itemizedTipCents: method === "itemized" ? tipCents : undefined,
      expectedUpdatedAt: existing?.updatedAt,
    };

    if (groupSwitching) return;
    setBusy(true);
    try {
      let expenseId: number;
      const createdNewExpense = !existing;
      if (existing) {
        await api(`/api/expenses/${existing.id}`, { method: "PATCH", body });
        expenseId = existing.id;
        // Details cached from before the edit would show the old amount and send
        // the old version with the next delete, which the server refuses.
        refreshExpenseDetails(expenseId);
      } else {
        const r = await api<{ id: number }>(`/api/groups/${groupId}/expenses`, { body });
        expenseId = r.id;
      }
      try {
        for (const f of files) {
          const form = new FormData();
          form.append("file", f);
          await api(`/api/expenses/${expenseId}/attachments`, { form });
        }
      } catch (err) {
        const message = !navigator.onLine
          ? "You are offline. Reconnect and try again."
          : err instanceof ApiClientError ? err.message : "Receipt upload failed";
        onSaved();
        if (createdNewExpense) rememberExpenseGroup(groupId);
        if (createdNewExpense) {
          onClose();
          toast(`Expense saved, but receipt upload failed: ${message}`, { tone: "error" });
          return;
        }
        setError(`Expense saved, but receipt upload failed: ${message}`);
        setBusy(false);
        return;
      } finally {
        // Receipts are part of the details, so read them again with the new ones.
        if (!createdNewExpense && files.length > 0) refreshExpenseDetails(expenseId);
      }
      onSaved();
      if (createdNewExpense) rememberExpenseGroup(groupId);
      if (createdNewExpense && onCreated) onCreated({ id: expenseId, title: body.title });
      else toast(createdNewExpense ? "Expense added" : "Expense updated");
      onClose();
    } catch (err) {
      setError(
        !navigator.onLine
          ? "You are offline. Reconnect to save this expense."
          : err instanceof ApiClientError ? err.message : "Could not save expense"
      );
      setBusy(false);
    }
  }

  const sectionCls = "space-y-3 rounded-xl border border-line p-3";
  const pickedGroupName = groupOptions?.find((g) => g.id === selectedGroupId)?.name ?? "that group";
  return (
    <Modal open={open} onClose={onClose} title={existing ? "Edit expense" : "Add expense"} wide>
      <form onSubmit={submit} className="space-y-3">
        {groupOptions && groupOptions.length > 1 && !existing ? (
          <div className="space-y-2">
          <div className={`group-choice group-hue-${(selectedGroupId ?? groupId) % 6} flex items-center gap-2 rounded-xl bg-[var(--group-soft)] py-1.5 pl-3 pr-1.5 text-[var(--group-ink)]`}>
            <Users className="h-4 w-4 shrink-0" aria-hidden />
            <label htmlFor="expense-group" className="shrink-0 text-body font-medium">Group</label>
            <Select
              id="expense-group"
              value={selectedGroupId ?? groupId}
              onChange={(e) => onGroupChange?.(Number(e.target.value))}
              className="!border-transparent !bg-card/70 font-semibold"
            >
              {groupOptions.map((g) => <option key={g.id} value={g.id}>{g.name} · {g.currency}</option>)}
            </Select>
          </div>
          {groupSwitching && (groupSwitchError ? (
            <ActionError title={`Could not load ${pickedGroupName}. What you typed is kept.`} message={groupSwitchError} onRetry={() => onRetryGroupSwitch?.()}>
              <Button type="button" size="sm" variant="ghost" onClick={() => onGroupChange?.(groupId)}>Back to {groupName}</Button>
            </ActionError>
          ) : (
            <p role="status" className="text-meta text-ink-faint">Loading {pickedGroupName}&apos;s members…</p>
          ))}
          </div>
        ) : (
          <p className={`group-choice group-hue-${groupId % 6} flex min-h-[var(--control-h-sm)] items-center gap-2 rounded-xl bg-[var(--group-soft)] px-3 py-1.5 text-body text-[var(--group-ink)]`}>
            <Users className="h-4 w-4 shrink-0" aria-hidden />
            <span className="sr-only">Group: </span>
            <span className="truncate font-semibold">{groupName}</span>
            <span className="shrink-0 text-[var(--group-muted)]">· {groupCurrency}</span>
          </p>
        )}

        <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
          <Field label={method === "itemized" ? "Total" : "Amount"}>
            <Input
              id="expense-amount"
              inputMode="decimal"
              enterKeyHint="next"
              value={displayedAmount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => {
                // Return moves on to the description instead of submitting a half-filled form.
                if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                e.preventDefault();
                document.getElementById("expense-title")?.focus();
              }}
              required={method !== "itemized"}
              readOnly={method === "itemized" && itemSubtotalCents > 0}
              placeholder="0.00"
              data-autofocus
              className="!min-h-14 !text-amount-lg !font-semibold tracking-tight tnum"
            />
          </Field>
          <Field label="Currency">
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)} className="!min-h-14">
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Description">
          <Input id="expense-title" value={title} onChange={(e) => setTitle(e.target.value)} enterKeyHint="done" required maxLength={120} placeholder="Dinner, groceries, tickets…" />
        </Field>

        <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
          <Field label="Paid by">
            <Select value={payerId} onChange={(e) => setPayerId(Number(e.target.value))} disabled={groupSwitching}>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.id === meId ? `${m.displayName} (you)` : m.displayName}</option>
              ))}
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <div className="col-span-2 sm:col-span-1">
            <Field label="Category">
              <Select
                id="expense-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value === "" ? "" : Number(e.target.value))}
                aria-describedby={categoriesError ? "expense-category-error" : undefined}
              >
                <option value="">No category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.custom ? " (custom)" : ""}</option>
                ))}
              </Select>
            </Field>
          </div>

          {categoriesError && (
            <div className="col-span-2 flex flex-wrap items-center gap-1 text-meta text-danger sm:col-span-3">
              <p id="expense-category-error" role="alert">Categories could not load.</p>
              <button type="button" onClick={reloadCategories} className="min-h-[var(--control-h-sm)] px-1 font-semibold underline">
                Try again
              </button>
            </div>
          )}

          {addingCat ? (
            <div className="col-span-2 flex gap-2 sm:col-span-3">
              <Input
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                aria-label="New category name"
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  void addCategory();
                }}
                placeholder="New category name"
                disabled={categoryBusy}
                autoFocus
              />
              <Button type="button" variant="secondary" onClick={addCategory} busy={categoryBusy} disabled={!newCategory.trim()}>Add</Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setAddingCat(false);
                  setNewCategory("");
                  requestAnimationFrame(() => document.getElementById("expense-new-category")?.focus());
                }}
                disabled={categoryBusy}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <button
              type="button"
              id="expense-new-category"
              onClick={() => setAddingCat(true)}
              className="col-span-2 inline-flex min-h-[var(--control-h-sm)] items-center gap-1 justify-self-start rounded-lg px-1 text-body font-medium text-accent hover:bg-accent-soft sm:col-span-3"
            >
              <Plus className="h-4 w-4" /> New category
            </button>
          )}
        </div>

        <fieldset className={`${sectionCls} ${groupSwitching ? "opacity-50" : ""}`} disabled={groupSwitching} aria-busy={groupSwitching}>
          <legend className="sr-only">Split</legend>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Split method" onKeyDown={radioGroupKeyDown}>
            {(Object.keys(METHOD_LABELS) as Method[]).map((m, index) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={method === m}
                tabIndex={radioTabIndex(method === m, index, true)}
                onClick={() => {
                  if (m === "equal" && method === "solo") setSelected(new Set(members.map((member) => member.id)));
                  setMethod(m);
                  if (m === "solo") setSelected(new Set([selected.values().next().value ?? defaultSoloId]));
                }}
                className={`min-h-[var(--control-h-sm)] rounded-lg border px-2.5 py-1 text-body font-medium transition-colors ${
                  method === m
                    ? "border-accent bg-accent-soft text-accent-dark"
                    : "border-line text-ink-soft hover:border-line-strong hover:text-ink"
                }`}
              >
                {METHOD_LABELS[m]}
              </button>
            ))}
          </div>

          {method !== "itemized" ? (
            <ParticipantSplit
              members={members}
              selected={selected}
              method={method}
              values={values}
              amountCents={amountCents}
              currency={currency}
              participantCount={participantList.length}
              onToggle={toggleMember}
              onValue={(id, value) => setValues((v) => ({ ...v, [id]: value }))}
            />
          ) : (
            <ItemizedSplit
              members={members}
              items={items}
              setItems={setItems}
              currency={currency}
              subtotalCents={itemSubtotalCents}
              taxEnabled={taxEnabled}
              taxRate={taxRate}
              taxCents={taxCents}
              tipEnabled={tipEnabled}
              tipRate={tipRate}
              tipCents={tipCents}
              totalCents={itemizedTotalCents}
              onTaxEnabled={setTaxEnabled}
              onTaxRate={setTaxRate}
              onTipEnabled={setTipEnabled}
              onTipRate={setTipRate}
            />
          )}

          {splitStatus && (
            <p
              className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-body ${splitStatus.ok ? "bg-owed-soft text-owed" : "bg-owe-soft text-owe"}`}
              role="status"
            >
              {/* Icon so the valid/incomplete state isn't conveyed by color alone. */}
              {splitStatus.ok ? <Check className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
              {splitStatus.msg}
            </p>
          )}
        </fieldset>

        <div className="rounded-xl border border-line">
          <button
            type="button"
            onClick={() => setShowDetails((shown) => !shown)}
            aria-expanded={showDetails}
            className="flex min-h-[var(--control-h)] w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-body font-medium text-ink-soft hover:bg-subtle"
          >
            <Paperclip className="h-4 w-4" />
            <span className="flex-1">{showDetails ? "Note and receipts" : "Add note or receipt"}</span>
            {(notes.trim() || files.length > 0 || savedAttachments.length > 0) && !showDetails && (
              <span className="text-meta text-ink-faint">
                {[notes.trim() && "note", (files.length + savedAttachments.length) > 0 && `${files.length + savedAttachments.length} receipt${files.length + savedAttachments.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
              </span>
            )}
            <ChevronDown className={`h-4 w-4 transition-transform ${showDetails ? "rotate-180" : ""}`} />
          </button>
          {showDetails && (
            <div className="space-y-3 border-t border-line p-3">
              <Field label="Notes">
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} />
              </Field>

              <Field label="Receipts" hint="Images or PDF, up to 4 MB each">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex min-h-[var(--control-h)] cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-body font-medium text-ink-soft hover:bg-subtle hover:text-ink">
                    <Paperclip className="h-4 w-4" /> Attach file
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      className="sr-only"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setFiles((fs) => [...fs, f]);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {files.map((f, i) => (
                    <span key={i} className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent-soft pl-2.5 text-meta text-accent-dark">
                      <span className="truncate">{f.name}</span>
                      <button type="button" className="inline-flex h-[var(--control-h-sm)] w-[var(--control-h-sm)] items-center justify-center rounded-full hover:bg-card/60" aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                  {savedAttachments.map((a) => (
                    <span
                      key={a.id}
                      className="inline-flex max-w-full items-center gap-1 rounded-full bg-subtle pl-2.5 text-meta text-ink-soft"
                    >
                      <a href={`/api/attachments/${a.id}`} target="_blank" className="truncate underline">
                        {a.filename}
                      </a>
                      <button
                        type="button"
                        aria-label={`Remove ${a.filename}`}
                        className="inline-flex h-[var(--control-h-sm)] w-[var(--control-h-sm)] items-center justify-center rounded-full text-ink-faint hover:bg-danger-soft hover:text-danger"
                        onClick={async () => {
                          if (!(await confirmAction({ title: "Remove receipt?", message: `Remove “${a.filename}” from this expense?`, confirmLabel: "Remove receipt", danger: true }))) return;
                          try {
                            await api(`/api/attachments/${a.id}`, { method: "DELETE" });
                            setSavedAttachments((xs) => xs.filter((x) => x.id !== a.id));
                            onSaved();
                          } catch (err) {
                            setError(err instanceof ApiClientError ? err.message : "Could not remove the receipt");
                          }
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              </Field>
            </div>
          )}
        </div>

        <ErrorNote message={error} />
        {/* Sticky so Cancel/Submit stay reachable while the long form scrolls
            (on short screens they used to scroll out of the viewport). */}
        <div className="sticky -bottom-4 -mx-4 -mb-4 flex justify-end gap-2 rounded-b-2xl border-t border-line bg-card px-4 py-2.5">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={groupSwitching || (splitStatus ? !splitStatus.ok : false)}>
            {busy ? "Saving…" : existing ? "Save changes" : "Add expense"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
