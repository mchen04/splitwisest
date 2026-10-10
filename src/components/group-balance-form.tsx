"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Users } from "lucide-react";
import { api, ApiClientError, fmtMoney, useSync } from "@/lib/client";
import { simplifyDebts } from "@/lib/money";
import { computeGroupObligation, formatGroupWeight, groupObligationCreatePayload, groupObligationDelta, parseGroupMoney, parseGroupWeight, GROUP_BALANCE_RECORD_CONFLICT, type SavedGroupObligation } from "@/lib/group-obligation-math";
import { currencyStep } from "@/lib/currencies";
import { Button, ErrorNote, Field, Input, Modal, radioGroupKeyDown, radioTabIndex } from "./ui";
import { METHOD_LABELS, ParticipantSplit } from "./expense-splits";
import type { Member } from "./expense-form";

type Method = "equal" | "exact" | "percentage" | "shares";
type Side = {
  method: Method;
  selected: Set<number>;
  values: Record<number, string>;
};

export interface ExistingGroupBalance extends SavedGroupObligation {
  id: number;
  title: string;
  updatedAt: string;
  changeCursor: number;
  balances: { userId: number; netCents: number }[];
}

const methods: Method[] = ["equal", "exact", "percentage", "shares"];

function initialSide(ids: number[]): Side {
  return { method: "equal", selected: new Set(ids), values: {} };
}

function savedSide(saved: ExistingGroupBalance["owes"]): Side {
  return {
    method: saved.method,
    selected: new Set(saved.participants.map((p) => p.userId)),
    values: Object.fromEntries(saved.participants.map((p) => [p.userId,
      saved.method === "exact" ? (p.shareCents / 100).toFixed(2) : p.value === null ? "" : formatGroupWeight(p.value),
    ])),
  };
}

function sideInput(side: Side, members: Member[]) {
  const participants = members.filter((m) => side.selected.has(m.id)).map((m) => {
    if (side.method === "equal") return { userId: m.id };
    const raw = side.values[m.id]?.trim() ?? "";
    if (!raw) throw new Error(`Enter a value for ${m.displayName}`);
    const value = side.method === "exact" ? parseGroupMoney(raw) : parseGroupWeight(raw);
    if (value === null && side.method !== "exact" && /^\d+[.,]\d+$/.test(raw) &&
      raw.split(/[.,]/)[1].length > 7) throw new Error(`Use at most 7 decimal places for ${m.displayName}`);
    if (value === null) throw new Error(`Enter a valid value for ${m.displayName}`);
    return { userId: m.id, value };
  });
  if (!participants.length) throw new Error("Select at least one person on each side");
  return { method: side.method, participants };
}

export function GroupBalanceForm({ groupId, groupName, currency, members, meId, balances, balanceListCursor, existing, open, onClose, onSaved, onRefresh }: {
  groupId: number;
  groupName: string;
  currency: string;
  members: Member[];
  meId: number;
  balances: { userId: number; netCents: number }[];
  balanceListCursor: number | null;
  existing: ExistingGroupBalance | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  onRefresh: () => void;
}) {
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [owes, setOwes] = useState<Side>(() => initialSide(members.map((m) => m.id)));
  const [receives, setReceives] = useState<Side>(() => initialSide([meId]));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const createRequest = useRef({ id: "", payload: "" });
  const [recordConflict, setRecordConflict] = useState(false);
  const recordConflictRef = useRef(false);
  const [verified, setVerified] = useState<{ recordId: number; version: string; changeCursor: number;
    balances: { userId: number; netCents: number }[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const activeCheck = useRef<{ recordId: number; queued: boolean } | null>(null);
  const checkSeq = useRef(0);
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => { onRefreshRef.current = onRefresh; }, [onRefresh]);

  useEffect(() => {
    if (!open) return;
    setTitle(existing?.title ?? "");
    setAmount(existing ? (existing.amountCents / 100).toFixed(2) : "");
    setOwes(existing ? savedSide(existing.owes) : initialSide(members.map((m) => m.id)));
    setReceives(existing ? savedSide(existing.receives) : initialSide([meId]));
    setError(null);
    setRecordConflict(false);
    recordConflictRef.current = false;
    setVerified(null);
    setChecking(false);
    setCheckError(false);
    activeCheck.current = null;
    checkSeq.current++;
    setBusy(false);
    saving.current = false;
    createRequest.current = { id: crypto.randomUUID(), payload: "" };
    // Membership sync must not clear a live draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);

  useEffect(() => () => {
    activeCheck.current = null;
    checkSeq.current++;
  }, [open, existing?.id]);

  const checkedSnapshot = existing && verified?.recordId === existing.id &&
    verified.version === existing.updatedAt && verified.changeCursor >= existing.changeCursor
    ? verified : existing;
  const listPending = checkedSnapshot !== null && open && balanceListCursor !== null &&
    balanceListCursor > checkedSnapshot.changeCursor;
  const unverified = !!existing && (checking || checkError || listPending);
  const previewBalances = checkedSnapshot?.balances ?? balances;

  const checkEditedRecord = useCallback(function checkEditedRecord() {
    if (!open || !existing || saving.current || recordConflictRef.current) return;
    if (activeCheck.current?.recordId === existing.id) {
      activeCheck.current.queued = true;
      return;
    }
    const request = { recordId: existing.id, queued: false };
    activeCheck.current = request;
    const seq = ++checkSeq.current;
    setChecking(true);
    api<{ balance: ExistingGroupBalance }>(`/api/group-balances/${existing.id}`)
      .then(({ balance }) => {
        if (seq !== checkSeq.current || saving.current) return;
        if (balance.updatedAt !== existing.updatedAt) {
          recordConflictRef.current = true;
          setRecordConflict(true);
          setError(GROUP_BALANCE_RECORD_CONFLICT);
          onRefreshRef.current();
          return;
        }
        setVerified({ recordId: existing.id, version: existing.updatedAt,
          changeCursor: balance.changeCursor, balances: balance.balances });
        setCheckError(false);
      })
      .catch((error) => {
        if (seq !== checkSeq.current || saving.current) return;
        if (error instanceof ApiClientError && error.status === 404) {
          recordConflictRef.current = true;
          setRecordConflict(true);
          setError(GROUP_BALANCE_RECORD_CONFLICT);
          onRefreshRef.current();
        } else setCheckError(true);
      })
      .finally(() => {
        if (activeCheck.current !== request) return;
        activeCheck.current = null;
        if (request.queued && !recordConflictRef.current && !saving.current) checkEditedRecord();
        else if (seq === checkSeq.current && !recordConflictRef.current) setChecking(false);
      });
  }, [open, existing]);

  useSync(checkEditedRecord, true);
  useEffect(() => {
    if (listPending) checkEditedRecord();
  }, [listPending, balanceListCursor, checkEditedRecord]);

  const preview = useMemo(() => {
    if (recordConflict || unverified) return { error: GROUP_BALANCE_RECORD_CONFLICT };
    const amountCents = parseGroupMoney(amount);
    if (amountCents === null || amountCents <= 0) return { error: "Enter a positive total" };
    const step = currencyStep(currency);
    if (amountCents % step) return { error: "Total must be whole units for this currency" };
    try {
      const owedInput = sideInput(owes, members);
      const receivedInput = sideInput(receives, members);
      const body = { title: title.trim(), amountCents, owes: owedInput, receives: receivedInput,
        expectedUpdatedAt: existing?.updatedAt,
        expectedBalances: previewBalances.map((b) => [b.userId, b.netCents] as [number, number]).sort((a, b) => a[0] - b[0]),
      };
      const recordNet = computeGroupObligation(body, new Set(members.map((m) => m.id)), currency, existing ?? undefined).net;
      const delta = groupObligationDelta(recordNet, existing ?? undefined);
      const currentNet = new Map(previewBalances.map((b) => [b.userId, b.netCents]));
      const after = new Map(members.map((m) => [m.id,
        (currentNet.get(m.id) ?? 0) + (delta.get(m.id) ?? 0),
      ]));
      const affected = new Set([
        ...owes.selected, ...receives.selected,
        ...(existing?.owes.participants.map((p) => p.userId) ?? []),
        ...(existing?.receives.participants.map((p) => p.userId) ?? []),
      ]);
      return {
        body,
        delta, affected, suggestions: simplifyDebts(after),
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Check the allocations" };
    }
  }, [amount, owes, receives, title, members, existing, previewBalances, currency, recordConflict, unverified]);

  function renderSide(name: "owes" | "receives", side: Side, setSide: React.Dispatch<React.SetStateAction<Side>>) {
    return (
      <section className="space-y-3 rounded-xl border border-line p-3" aria-label={name === "owes" ? "Who owes" : "Who should receive"}>
        <h3 className="text-body font-semibold">{name === "owes" ? "Who owes" : "Who should receive"}</h3>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={`${name} split method`} onKeyDown={radioGroupKeyDown}>
          {methods.map((method, index) => (
            <button key={method} type="button" role="radio" aria-checked={side.method === method}
              tabIndex={radioTabIndex(side.method === method, index, methods.includes(side.method))}
              onClick={() => setSide((s) => ({ ...s, method }))}
              className={`min-h-[var(--control-h-sm)] rounded-lg border px-2.5 py-1 text-body font-medium ${
                side.method === method ? "border-accent bg-accent-soft text-accent-dark" : "border-line text-ink-soft hover:border-line-strong"
              }`}>{METHOD_LABELS[method]}</button>
          ))}
        </div>
        <ParticipantSplit members={members} selected={side.selected} method={side.method} values={side.values}
          idPrefix={`${name}-p`}
          amountCents={parseGroupMoney(amount) ?? 0} currency={currency} participantCount={side.selected.size}
          onToggle={(id) => setSide((s) => {
            const selected = new Set(s.selected);
            if (selected.has(id)) selected.delete(id); else selected.add(id);
            return { ...s, selected };
          })}
          onValue={(id, value) => setSide((s) => ({ ...s, values: { ...s.values, [id]: value } }))}
        />
      </section>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving.current) return;
    if (recordConflict) return setError(GROUP_BALANCE_RECORD_CONFLICT);
    if (unverified) return;
    setError(null);
    if (!title.trim()) return setError("Enter a description");
    if (!preview.body) return setError(preview.error ?? "Check the allocations");
    saving.current = true;
    setBusy(true);
    try {
      if (existing) await api(`/api/group-balances/${existing.id}`, { method: "PATCH", body: preview.body });
      else {
        const payload = groupObligationCreatePayload(preview.body);
        if (createRequest.current.payload && createRequest.current.payload !== payload) {
          createRequest.current.id = crypto.randomUUID();
        }
        createRequest.current.payload = payload;
        await api(`/api/groups/${groupId}/group-balances`, { body: {
          ...preview.body, clientRequestId: createRequest.current.id,
        } });
      }
      onSaved();
      onClose();
    } catch (e) {
      const missingEdit = existing && e instanceof ApiClientError && e.status === 404;
      const changedEdit = e instanceof ApiClientError && e.message === GROUP_BALANCE_RECORD_CONFLICT;
      setError(missingEdit || changedEdit ? GROUP_BALANCE_RECORD_CONFLICT :
        e instanceof ApiClientError ? e.message : "Could not save group balance");
      if (missingEdit || changedEdit) {
        recordConflictRef.current = true;
        setRecordConflict(true);
        onRefresh();
      } else if (e instanceof ApiClientError && e.message.includes("Group balances changed")) onRefresh();
      saving.current = false;
      setBusy(false);
      setChecking(false);
    }
  }

  function dismiss() {
    if (!saving.current) onClose();
  }

  return (
    <Modal open={open} onClose={dismiss} title={existing ? "Edit group balance" : "Add group balance"} closeDisabled={busy} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className={`group-choice group-hue-${groupId % 6} flex items-center gap-2 rounded-xl bg-[var(--group-soft)] px-3 py-2 text-[var(--group-ink)]`}>
          <Users className="h-4 w-4" /> <span className="text-body font-semibold">{groupName} · {currency}</span>
        </div>
        {recordConflict && <ErrorNote message={error} />}
        {!recordConflict && checkError && <div className="flex items-center gap-2">
          <ErrorNote message="Could not verify this group balance" />
          <Button type="button" variant="secondary" onClick={checkEditedRecord}>Try again</Button>
        </div>}
        {!recordConflict && unverified && !checkError && <p role="status" className="text-body text-ink-soft">Checking group balance changes…</p>}
        <Field label="Total to settle">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required
            data-autofocus className="!min-h-14 !text-amount-lg !font-semibold tracking-tight tnum" />
        </Field>
        <Field label="Description">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required
            placeholder="Shared balance" />
        </Field>
        {renderSide("owes", owes, setOwes)}
        {renderSide("receives", receives, setReceives)}
        {preview.body && preview.delta ? (
          <div className="space-y-3 rounded-xl border border-line p-3" aria-label="Balance preview">
            <h3 className="text-body font-semibold">Preview</h3>
            <p className="text-meta text-ink-faint">{existing ? "This replaces obligations." : "This adds obligations."} It does not record a payment.</p>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {members.filter((m) => preview.affected?.has(m.id)).map((m) => {
                const net = preview.delta?.get(m.id) ?? 0;
                return <li key={m.id} className="flex justify-between gap-3 px-3 py-2 text-body">
                  <span className="truncate">{m.displayName}</span>
                  <span className="tnum font-medium">{net > 0 ? `receives ${fmtMoney(net, currency)}` : net < 0 ? `owes ${fmtMoney(-net, currency)}` : "no net change"}</span>
                </li>;
              })}
            </ul>
            <p className="text-meta font-semibold text-ink-soft">Resulting group debts</p>
            {preview.suggestions?.length ? <ul className="space-y-1 text-body">
              {preview.suggestions.map((s, i) => <li key={i}>
                {members.find((m) => m.id === s.from)?.displayName} owes {members.find((m) => m.id === s.to)?.displayName} {fmtMoney(s.amountCents, currency)}
              </li>)}
            </ul> : <p className="text-body text-ink-faint">All settled up</p>}
          </div>
        ) : amount && !recordConflict && <p role="status" className="flex items-center gap-1.5 rounded-lg bg-owe-soft px-3 py-2 text-body text-owe">
          <AlertCircle className="h-4 w-4 shrink-0" /> {preview.error}
        </p>}
        {preview.body && <p role="status" className="flex items-center gap-1.5 rounded-lg bg-owed-soft px-3 py-2 text-body text-owed">
          <Check className="h-4 w-4 shrink-0" /> Both sides match {fmtMoney(preview.body.amountCents, currency)}
        </p>}
        {!recordConflict && <ErrorNote message={error} />}
        <div className="sticky -bottom-4 -mx-4 -mb-4 flex justify-end gap-2 rounded-b-2xl border-t border-line bg-card px-4 py-2.5">
          <Button type="button" variant="secondary" onClick={dismiss} disabled={busy}>Cancel</Button>
          <Button type="submit" busy={busy} disabled={!preview.body || !title.trim()}>
            {existing ? "Save group balance" : "Create group balance"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
