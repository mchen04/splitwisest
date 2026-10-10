"use client";

import { Wallet } from "lucide-react";

export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-5">
      <div className="rise-in w-full max-w-sm">
        <div className="mb-4 flex flex-col items-center gap-2">
          <div className="flex items-center justify-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-on-accent">
              <Wallet className="h-5 w-5" />
            </span>
            <span className="font-wordmark text-title font-semibold tracking-tight">SplitWisest</span>
          </div>
          <p className="text-pretty px-2 text-center text-body text-ink-soft [text-wrap:balance]">
            A private shared-expense ledger for friends — see who owes whom and settle up offline.
          </p>
        </div>
        <div className="rounded-2xl border border-line bg-card p-6 shadow-card">{children}</div>
        <p className="mt-4 text-center text-meta text-ink-faint">
          Not a payment app — settlements are records of payments made offline.
        </p>
      </div>
    </div>
  );
}
