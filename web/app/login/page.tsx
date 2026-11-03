"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type AuthMode = "login" | "register";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  function changeMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError("");
    setConfirmation("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "register" && password !== confirmation) {
      setError("Your passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Could not ${mode === "login" ? "sign in" : "create your account"}.`);
      router.replace("/chats");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const creating = mode === "register";
  return <main className="center-page">
    <div className="auth-card">
      <div className="segmented" role="tablist" aria-label="Account access">
        <button type="button" role="tab" aria-selected={!creating} className={!creating ? "active" : ""} onClick={() => changeMode("login")}>Sign in</button>
        <button type="button" role="tab" aria-selected={creating} className={creating ? "active" : ""} onClick={() => changeMode("register")}>Create account</button>
      </div>
      <h1>{creating ? "Create your account" : "Welcome back"}</h1>
      <p className="muted">{creating ? "Only one account can exist, because it can read all your messages." : "Sign in to read your chats."}</p>
      {error && <div className="notice" role="alert">{error}</div>}
      <form onSubmit={submit}>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="email" inputMode="email" placeholder="you@example.com" value={email} onChange={event => setEmail(event.target.value)} required />
        <label htmlFor="password">Password{creating && <span className="muted"> (12+ characters)</span>}</label>
        <div className="password">
          <input id="password" type={showPassword ? "text" : "password"} autoComplete={creating ? "new-password" : "current-password"} minLength={creating ? 12 : undefined} value={password} onChange={event => setPassword(event.target.value)} required />
          <button type="button" onClick={() => setShowPassword(!showPassword)} aria-pressed={showPassword}>{showPassword ? "Hide" : "Show"}</button>
        </div>
        {creating && <>
          <label htmlFor="password-confirmation">Confirm password</label>
          <input id="password-confirmation" type={showPassword ? "text" : "password"} autoComplete="new-password" minLength={12} value={confirmation} onChange={event => setConfirmation(event.target.value)} required />
        </>}
        <button className="primary" disabled={busy}>{busy ? (creating ? "Creating account…" : "Signing in…") : (creating ? "Create account" : "Sign in")}</button>
      </form>
    </div>
  </main>;
}
