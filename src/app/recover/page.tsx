"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiClientError } from "@/lib/client";
import { Button, Field, Input, ErrorNote } from "@/components/ui";
import { AuthFrame } from "@/components/auth-frame";

export default function RecoverPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/recover", { body: { username, code, newPassword } });
      router.push("/");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not recover account");
      setBusy(false);
    }
  }

  return (
    <AuthFrame>
      <h1 className="text-title font-semibold tracking-tight">Reset password</h1>
      <p className="mt-1 text-body text-ink-soft">Enter your username and a recovery code to set a new password.</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <Field label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </Field>
        <Field label="Recovery code">
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXXX-XXXXX" required className="font-mono" />
        </Field>
        <Field label="New password">
          <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" required />
        </Field>
        <ErrorNote message={error} />
        <Button type="submit" busy={busy} className="w-full">Reset password</Button>
      </form>
      <p className="mt-4 text-center text-body">
        <Link href="/login" className="font-semibold text-accent hover:text-accent-dark">Back to log in</Link>
      </p>
    </AuthFrame>
  );
}
