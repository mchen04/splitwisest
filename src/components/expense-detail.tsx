"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Pencil, Trash2, Paperclip, FileText, SendHorizonal, MessageSquare, History } from "lucide-react";
import { api, fmtDate, fmtMoney, fmtTime, useApiData } from "@/lib/client";
import { Change, describeChange } from "@/lib/activity-diff";
import { Modal, Button, Avatar, Input, SectionLabel } from "./ui";

interface Detail {
  id: number;
  title: string;
  amountCents: number;
  currency: string;
  date: string;
  payerId: number;
  notes: string;
  splitMethod: string;
  updatedAt: string;
  shares: { userId: number; shareCents: number; displayName: string }[];
  items: { id: number; name: string; amountCents: number; participantIds: number[] }[];
  attachments: { id: number; filename: string; mime: string }[];
}

interface Comment {
  id: number;
  authorId: number;
  authorName: string;
  body: string;
  createdAt: string;
}

const METHOD_LABEL: Record<string, string> = {
  equal: "Split equally",
  exact: "Exact amounts",
  percentage: "By percentage",
  shares: "By shares",
  itemized: "Itemized",
};

interface EditRecord {
  id: number;
  actorId: number;
  actorName: string;
  createdAt: string;
  changes: Change[];
}

export function ExpenseDetailModal({
  expenseId,
  meId,
  open,
  onClose,
  onEdit,
  onDelete,
}: {
  expenseId: number | null;
  meId: number;
  open: boolean;
  onClose: () => void;
  onEdit: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const enabled = open && expenseId !== null;
  const { data: detailData } = useApiData<{ expense: Detail }>(
    `/api/expenses/${expenseId ?? 0}`, 0, { sync: false, enabled }
  );
  const { data: commentsData } = useApiData<{ comments: Comment[] }>(
    `/api/expenses/${expenseId ?? 0}/comments`, 0, { sync: false, enabled }
  );
  const { data: historyData } = useApiData<{ edits: EditRecord[] }>(
    `/api/expenses/${expenseId ?? 0}/history`, 0, { sync: false, enabled }
  );
  const edits = historyData?.edits ?? null;
  const detail = detailData?.expense ?? null;
  const [localComments, setLocalComments] = useState<{ expenseId: number; comments: Comment[] } | null>(null);
  const comments = localComments?.expenseId === expenseId
    ? localComments.comments
    : commentsData?.comments ?? null;
  const [draftState, setDraftState] = useState<{ expenseId: number; value: string } | null>(null);
  const draft = draftState?.expenseId === expenseId ? draftState.value : "";
  const setDraft = (value: string) => setDraftState({ expenseId: expenseId ?? 0, value });
  const [sending, setSending] = useState(false);
  const commentsEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    commentsEnd.current?.scrollIntoView({ block: "nearest" });
  }, [comments?.length]);

  async function sendComment(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending || expenseId === null) return;
    setSending(true);
    try {
      const r = await api<{ comment: Comment }>(`/api/expenses/${expenseId}/comments`, { body: { body } });
      setLocalComments({ expenseId, comments: [...(comments ?? []), r.comment] });
      setDraft("");
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={detail?.title ?? "Expense"}
      wide
      footer={detail && (
        // Kept outside the scrolling body so Edit and Delete never sit below a long thread.
        <>
          <Button variant="danger" onClick={() => onDelete(detail.id)}>
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
          <Button variant="secondary" onClick={() => onEdit(detail.id)}>
            <Pencil className="h-4 w-4" /> Edit
          </Button>
        </>
      )}
    >
      {!detail ? (
        <div className="space-y-3">{[...Array(4)].map((_, i) => <div key={i} className="skeleton h-10 w-full" />)}</div>
      ) : (
        <div className="space-y-4">
          {/* Header summary */}
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="tnum text-amount font-semibold tracking-tight">{fmtMoney(detail.amountCents, detail.currency)}</p>
              <p className="text-body text-ink-soft">{fmtDate(detail.date)} · {METHOD_LABEL[detail.splitMethod] ?? detail.splitMethod}</p>
            </div>
            <p className="text-body text-ink-soft">
              Paid by{" "}
              <Link href={`/people/${detail.payerId}`} className="font-semibold hover:text-accent-dark hover:underline">
                {detail.shares.find((s) => s.userId === detail.payerId)?.displayName
                  ?? (detail.payerId === meId ? "you" : "a member")}
              </Link>
            </p>
          </div>

          {/* Split breakdown */}
          <div>
            <SectionLabel className="mb-1.5">Split breakdown</SectionLabel>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {detail.shares.map((s) => (
                <li key={s.userId} className="flex min-h-10 items-center gap-2.5 px-3 py-1.5 text-body">
                  <Link href={`/people/${s.userId}`} aria-label={`Open ${s.displayName}'s profile`}>
                    <Avatar name={s.displayName} size="sm" />
                  </Link>
                  <span className="min-w-0 flex-1 truncate">
                    <Link href={`/people/${s.userId}`} className="hover:text-accent-dark hover:underline">
                      {s.displayName}{s.userId === meId ? " (you)" : ""}
                    </Link>
                  </span>
                  <span className="tnum font-medium">{fmtMoney(s.shareCents, detail.currency)}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Itemized lines */}
          {detail.items.length > 0 && (
            <div>
              <SectionLabel className="mb-1.5">Items</SectionLabel>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {detail.items.map((i) => (
                  <li key={i.id} className="flex min-h-10 items-center justify-between gap-2 px-3 py-1.5 text-body">
                    <span className="min-w-0 flex-1 truncate">
                      {i.name}
                      <span className="text-ink-faint"> · {i.participantIds.length} {i.participantIds.length === 1 ? "person" : "people"}</span>
                    </span>
                    <span className="tnum font-medium">{fmtMoney(i.amountCents, detail.currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Notes */}
          {detail.notes.trim() && (
            <div>
              <SectionLabel className="mb-1.5">Notes</SectionLabel>
              <p className="whitespace-pre-wrap rounded-lg bg-subtle px-3 py-2 text-body text-ink-soft">{detail.notes}</p>
            </div>
          )}

          {/* Receipts */}
          {detail.attachments.length > 0 && (
            <div>
              <SectionLabel className="mb-1.5 flex items-center gap-1.5">
                <Paperclip className="h-3.5 w-3.5" /> Receipts
              </SectionLabel>
              <div className="flex flex-wrap gap-3">
                {detail.attachments.map((a) =>
                  a.mime.startsWith("image/") ? (
                    <a key={a.id} href={`/api/attachments/${a.id}`} target="_blank" rel="noopener noreferrer" className="block">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/attachments/${a.id}`}
                        alt={a.filename}
                        className="max-h-56 rounded-lg border border-line object-contain"
                      />
                    </a>
                  ) : (
                    <a
                      key={a.id}
                      href={`/api/attachments/${a.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[var(--control-h)] items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-body text-ink-soft hover:border-accent"
                    >
                      <FileText className="h-4 w-4" /> {a.filename}
                    </a>
                  )
                )}
              </div>
            </div>
          )}

          {/* Edit history — the full before and after, unlike the feed's one line. */}
          {edits !== null && edits.length > 0 && (
            <div>
              <SectionLabel className="mb-1.5 flex items-center gap-1.5">
                <History className="h-3.5 w-3.5" /> Edit history
              </SectionLabel>
              <ul className="space-y-2.5">
                {edits.map((e) => (
                  <li key={e.id} className="flex items-start gap-2.5">
                    <Link href={`/people/${e.actorId}`} aria-label={`Open ${e.actorName}'s profile`}>
                      <Avatar name={e.actorName} size="sm" />
                    </Link>
                    <div className="min-w-0 flex-1">
                      <p className="text-body">
                        <Link href={`/people/${e.actorId}`} className="font-medium hover:text-accent-dark hover:underline">
                          {e.actorId === meId ? "You" : e.actorName}
                        </Link>{" "}
                        <span className="text-meta text-ink-faint">{fmtTime(e.createdAt)}</span>
                      </p>
                      <ul className="mt-0.5 space-y-0.5">
                        {e.changes.map((c, i) => (
                          <li key={i} className="break-words text-body text-ink-soft">{describeChange(c)}</li>
                        ))}
                      </ul>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Comments */}
          <div>
            <SectionLabel className="mb-1.5 flex items-center gap-1.5">
              <MessageSquare className="h-3.5 w-3.5" /> Comments
            </SectionLabel>
            {comments === null ? (
              <div className="skeleton h-8 w-2/3" />
            ) : comments.length === 0 ? (
              <p className="text-body text-ink-faint">No comments yet. Start the discussion.</p>
            ) : (
              <ul className="space-y-2.5">
                {comments.map((c) => (
                  <li key={c.id} className="flex items-start gap-2.5">
                    <Link href={`/people/${c.authorId}`} aria-label={`Open ${c.authorName}'s profile`}>
                      <Avatar name={c.authorName} size="sm" />
                    </Link>
                    <div className="min-w-0 flex-1">
                      <p className="text-body">
                        <Link href={`/people/${c.authorId}`} className="font-medium hover:text-accent-dark hover:underline">
                          {c.authorId === meId ? "You" : c.authorName}
                        </Link>{" "}
                        <span className="text-meta text-ink-faint">{fmtTime(c.createdAt)}</span>
                      </p>
                      <p className="whitespace-pre-wrap break-words text-body text-ink-soft">{c.body}</p>
                    </div>
                  </li>
                ))}
                <div ref={commentsEnd} />
              </ul>
            )}
            <form onSubmit={sendComment} className="mt-3 flex items-center gap-2">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Add a comment…"
                aria-label="Add a comment"
                maxLength={2000}
              />
              <button
                type="submit"
                disabled={!draft.trim() || sending}
                aria-label="Post comment"
                className="flex h-[var(--control-h)] w-[var(--control-h)] shrink-0 items-center justify-center rounded-lg bg-accent text-on-accent transition-colors hover:bg-accent-dark disabled:opacity-40"
              >
                <SendHorizonal className="h-4.5 w-4.5" />
              </button>
            </form>
          </div>

        </div>
      )}
    </Modal>
  );
}
