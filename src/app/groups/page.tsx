"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Users, KeyRound } from "lucide-react";
import { api, useApiData, useFormState, CURRENCIES } from "@/lib/client";
import { AppShell } from "@/components/shell";
import { Card, EmptyState, Button, Modal, Field, Input, Select, ErrorNote, RowMeta, RowTitle } from "@/components/ui";
import { GroupNet } from "@/components/group-net";

interface Group {
  id: number;
  name: string;
  currency: string;
  inviteCode: string;
  memberCount: number;
  expenseCount: number;
  myNetCents: number;
}

export default function GroupsPage() {
  const router = useRouter();
  const { data } = useApiData<{ groups: Group[] }>("/api/groups");
  const groups = data?.groups ?? null;
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [code, setCode] = useState("");
  const { error, setError, busy, run } = useFormState();

  const openCreate = () => { setCreateOpen(true); setError(null); setName(""); };
  const openJoin = () => { setJoinOpen(true); setError(null); setCode(""); };

  function create(e: React.FormEvent) {
    e.preventDefault();
    run(async () => {
      const r = await api<{ id: number }>("/api/groups", { body: { name, currency } });
      router.push(`/groups/${r.id}`);
    }, "Could not create group");
  }

  function join(e: React.FormEvent) {
    e.preventDefault();
    run(async () => {
      const r = await api<{ id: number }>("/api/groups/join", { body: { code } });
      router.push(`/groups/${r.id}`);
    }, "Could not join group");
  }

  return (
    <AppShell title="Groups">
      {/* Actions first, so starting or joining a group never sits below a long list. */}
      <div className="mb-3 flex items-center gap-2 md:shrink-0">
        <p className="min-w-0 flex-1 text-body text-ink-soft">
          {groups && groups.length > 0 ? `${groups.length} ${groups.length === 1 ? "group" : "groups"}` : "\u00a0"}
        </p>
        <Button variant="secondary" onClick={openJoin} aria-label="Join with code">
          <KeyRound className="h-4 w-4" /> <span className="hidden min-[22rem]:inline">Join with code</span><span className="min-[22rem]:hidden">Join</span>
        </Button>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" /> New group
        </Button>
      </div>
      <div className="flex flex-col md:min-h-0 md:flex-1">
        <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
        {groups === null ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="skeleton h-16 w-full" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Users className="h-6 w-6" />}
              title="No groups yet"
              hint="Create one for a trip, an apartment, or a dinner crew — or join with an invite code."
            />
          </Card>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {groups.map((g) => (
              <li key={g.id}>
                <Link href={`/groups/${g.id}`} className={`group-choice group-hue-${g.id % 6} flex min-h-16 items-center gap-3 rounded-xl border border-line bg-card px-3.5 py-2 shadow-card transition-colors hover:bg-subtle`}>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--group-soft)] text-[var(--group-ink)]">
                    <Users className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <RowTitle className="!font-semibold" title={g.name}>{g.name}</RowTitle>
                    <RowMeta>
                      {g.memberCount} {g.memberCount === 1 ? "member" : "members"} · {g.expenseCount}{" "}
                      {g.expenseCount === 1 ? "expense" : "expenses"} · {g.currency}
                    </RowMeta>
                  </span>
                  <GroupNet cents={g.myNetCents} currency={g.currency} />
                </Link>
              </li>
            ))}
          </ul>
        )}
        </div>
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New group">
        <form onSubmit={create} className="space-y-3">
          <Field label="Group name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="Tahoe ski trip" data-autofocus />
          </Field>
          <Field label="Group currency" hint="Balances are shown in this currency. Expenses in other currencies convert automatically.">
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <ErrorNote message={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" busy={busy}>Create group</Button>
          </div>
        </form>
      </Modal>

      <Modal open={joinOpen} onClose={() => setJoinOpen(false)} title="Join a group">
        <form onSubmit={join} className="space-y-3">
          <Field label="Group invite code" hint="Ask a friend in the group for its invite code.">
            <Input value={code} onChange={(e) => setCode(e.target.value)} required data-autofocus autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </Field>
          <ErrorNote message={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setJoinOpen(false)}>Cancel</Button>
            <Button type="submit" busy={busy}>Join group</Button>
          </div>
        </form>
      </Modal>
    </AppShell>
  );
}
