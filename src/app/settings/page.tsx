"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Check, KeyRound, LogOut, ShieldCheck, UserCog, Palette, Moon, Sun } from "lucide-react";
import { api, useApiData, useFormState } from "@/lib/client";
import { useTheme } from "@/lib/theme";
import { AppShell } from "@/components/shell";
import { Card, CardHeader, Button, Field, Input, ErrorNote, Segmented, confirmAction, failureReason } from "@/components/ui";
import { NotificationSettingsCard } from "@/components/notification-settings";

interface Me {
  id: number;
  username: string;
  displayName: string;
  inviteCode: string;
}

export default function SettingsPage() {
  const router = useRouter();
  const { data } = useApiData<{ user: Me }>("/api/me", 0, { sync: false });
  const [savedMe, setSavedMe] = useState<Me | null>(null);
  const me = savedMe ?? data?.user ?? null;

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <AppShell title="Settings">
      {/* Two balanced columns so everything fits one screen on desktop. */}
      <div className="md:min-h-0 md:flex-1 md:overflow-y-auto md:pb-2">
        <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
          <div className="space-y-3">
            <ProfileCard me={me} onSaved={setSavedMe} />
            <AppearanceCard />
            <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
              <p className="text-row font-medium">{me ? <>Signed in as <span className="font-semibold">@{me.username}</span></> : "Account"}</p>
              <Button variant="danger" onClick={logout}>
                <LogOut className="h-4 w-4" /> Log out
              </Button>
            </Card>
          </div>
          <div className="space-y-3">
            <NotificationSettingsCard />
            <PasswordCard />
            <RecoveryCard />
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function AppearanceCard() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Palette className="h-4 w-4" /> Appearance</span>} />
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <p className="text-row font-medium">Theme</p>
        <Segmented
          label="Theme"
          value={dark ? "dark" : "light"}
          onChange={(value) => { if ((value === "dark") !== dark) toggle(); }}
          options={[
            { value: "light", label: <span className="flex items-center gap-1.5"><Sun className="h-4 w-4" /> Light</span> },
            { value: "dark", label: <span className="flex items-center gap-1.5"><Moon className="h-4 w-4" /> Dark</span> },
          ]}
        />
      </div>
    </Card>
  );
}

function ProfileCard({ me, onSaved }: { me: Me | null; onSaved: (m: Me) => void }) {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [done, setDone] = useState(false);
  const { error, busy, run } = useFormState();

  useEffect(() => {
    if (me) {
      // Seed the editable account form once the current user is loaded.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDisplayName(me.displayName);
      setUsername(me.username);
    }
  }, [me]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setDone(false);
    run(async () => {
      const r = await api<{ user: Me }>("/api/me", { method: "PATCH", body: { displayName, username } });
      onSaved(r.user);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    }, "Could not save profile");
  }

  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><UserCog className="h-4 w-4" /> Profile</span>} />
      <form onSubmit={submit} className="space-y-3 px-4 py-3">
        <Field label="Display name">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={50} disabled={!me} />
        </Field>
        <Field label="Username" hint="Letters, numbers, and underscores. Must be unique.">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} required disabled={!me} autoComplete="username" />
        </Field>
        <ErrorNote message={error} />
        <div className="flex items-center gap-3">
          <Button type="submit" busy={busy} disabled={!me}>Save profile</Button>
          {done && <span role="status" className="flex items-center gap-1 text-body text-owed"><Check className="h-4 w-4" /> Saved</span>}
        </div>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const { error, setError, busy, run } = useFormState();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setDone(false);
    if (newPassword !== confirm) return setError("New passwords do not match");
    run(async () => {
      await api("/api/auth/password", { body: { currentPassword, newPassword } });
      setCurrentPassword(""); setNewPassword(""); setConfirm("");
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    }, "Could not change password");
  }

  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> Password</span>} />
      <form onSubmit={submit} className="space-y-3 px-4 py-3">
        <Field label="Current password">
          <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required autoComplete="current-password" />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="New password">
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required autoComplete="new-password" />
          </Field>
          <Field label="Confirm new password">
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
          </Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex items-center gap-3">
          <Button type="submit" busy={busy}>Change password</Button>
          {done && <span role="status" className="flex items-center gap-1 text-body text-owed"><Check className="h-4 w-4" /> Password changed</span>}
        </div>
      </form>
    </Card>
  );
}

function RecoveryCard() {
  const { data, error: countError, reload: reloadCount } = useApiData<{ remaining: number }>("/api/me/recovery-codes", 0, { sync: false });
  const [generatedRemaining, setGeneratedRemaining] = useState<number | null>(null);
  // null while checking, and after a failed check: the count is unknown, not zero.
  const remaining = generatedRemaining ?? data?.remaining ?? null;
  const [codes, setCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const { error, busy, run } = useFormState();

  function regenerate() {
    void (async () => {
      if ((codes || remaining === null) && !(await confirmAction({
        title: "Generate new codes?",
        message: codes ? "Your old recovery codes will stop working." : "Any recovery codes you already have will stop working.",
        confirmLabel: "Generate new codes",
        danger: true,
      }))) return;
      run(async () => {
      const r = await api<{ codes: string[] }>("/api/me/recovery-codes", { method: "POST" });
      setCodes(r.codes);
      setGeneratedRemaining(r.codes.length);
      }, "Could not generate recovery codes");
    })();
  }

  function copyCodes() {
    if (!codes) return;
    navigator.clipboard.writeText(codes.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Account recovery</span>} />
      <div className="space-y-3 px-4 py-3">
        <p className="text-body text-ink-soft">
          Recovery codes let you reset your password if you forget it. Store them somewhere safe — each code works once.
        </p>
        {codes ? (
          <div className="rounded-lg border border-line bg-subtle p-3">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-body">
              {codes.map((c) => <span key={c}>{c}</span>)}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Button variant="secondary" onClick={copyCodes}>
                {copied ? <Check className="h-4 w-4 text-owed" /> : <Copy className="h-4 w-4" />} Copy codes
              </Button>
              <span className="text-meta text-ink-faint">These won&apos;t be shown again.</span>
            </div>
          </div>
        ) : remaining === null && countError ? (
          <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-danger-soft px-3 py-2 text-body text-danger">
            <p className="min-w-0 flex-1">Could not check how many codes you have left. {failureReason(countError)}</p>
            <Button type="button" size="sm" variant="secondary" onClick={reloadCount}>Try again</Button>
          </div>
        ) : (
          <p role={remaining === null ? "status" : undefined} className="text-body text-ink-faint">
            {remaining === null ? "Checking your recovery codes…" : remaining > 0
              ? `You have ${remaining} unused recovery ${remaining === 1 ? "code" : "codes"}.`
              : "You have no recovery codes yet."}
          </p>
        )}
        <ErrorNote message={error} />
        <Button variant={remaining === 0 ? "primary" : "secondary"} onClick={regenerate} busy={busy}>
          {remaining === 0 ? "Generate recovery codes" : remaining === null ? "Generate new codes" : "Regenerate codes"}
        </Button>
      </div>
    </Card>
  );
}
