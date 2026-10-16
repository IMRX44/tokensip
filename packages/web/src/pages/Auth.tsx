import { KeyRound, Lock, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Logo } from "../components/Logo";
import { Field } from "../components/ui";
import { LANGUAGES, useI18n } from "../i18n";
import { ApiError, api, setCsrf } from "../lib/api";

function LangSelect() {
  const { lang, setLang } = useI18n();
  return (
    <select
      className="select"
      style={{ width: 130, height: 32 }}
      value={lang}
      onChange={(e) => setLang(e.target.value as typeof lang)}
      aria-label="Language"
    >
      {LANGUAGES.map((l) => (
        <option key={l.id} value={l.id}>
          {l.label}
        </option>
      ))}
    </select>
  );
}

function Frame({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="auth">
      <div className="card auth-card">
        <div className="row between">
          <div className="auth-logo">
            <Logo size={40} />
            <div>
              <div className="brand-name">TokenSip</div>
              <div className="brand-tag">{t("app.tagline")}</div>
            </div>
          </div>
          <LangSelect />
        </div>
        <h1 className="page-title" style={{ fontSize: 22 }}>
          {title}
        </h1>
        <p className="page-sub" style={{ marginBottom: 20 }}>
          {subtitle}
        </p>
        {children}
        <div className="row small faint" style={{ marginTop: 22, gap: 6, justifyContent: "center" }}>
          <ShieldCheck size={14} /> {t("auth.security")}
        </div>
      </div>
    </div>
  );
}

export function SetupPage({ onDone }: { onDone(): void }) {
  const { t } = useI18n();
  const [token, setToken] = useState(() => new URLSearchParams(window.location.search).get("token") ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirm) return setError(t("auth.passwordMismatch"));
    setBusy(true);
    try {
      const r = await api<{ csrfToken: string }>("/auth/setup", { method: "POST", body: { token, password } });
      setCsrf(r.csrfToken);
      window.history.replaceState({}, "", "/");
      onDone();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(
        code === "invalid_setup_token"
          ? t("auth.invalidToken")
          : code === "too_many_attempts"
            ? t("auth.tooMany")
            : t("auth.passwordHint"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame title={t("auth.setupTitle")} subtitle={t("auth.setupSubtitle")}>
      <form className="stack" onSubmit={submit}>
        <Field label={t("auth.setupToken")}>
          <input
            className="input mono"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            autoComplete="off"
          />
        </Field>
        <Field label={t("auth.password")} hint={t("auth.passwordHint")}>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={10}
            required
            autoComplete="new-password"
          />
        </Field>
        <Field label={t("auth.confirmPassword")}>
          <input
            className="input"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            minLength={10}
            required
            autoComplete="new-password"
          />
        </Field>
        {error && (
          <div className="badge bad" style={{ alignSelf: "flex-start" }}>
            {error}
          </div>
        )}
        <button className="btn primary block" disabled={busy} type="submit">
          <KeyRound size={16} /> {t("auth.createAdmin")}
        </button>
      </form>
    </Frame>
  );
}

export function LoginPage({ onDone, totp }: { onDone(): void; totp: boolean }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needTotp, setNeedTotp] = useState(totp);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const r = await api<{ csrfToken: string }>("/auth/login", {
        method: "POST",
        body: { password, totp: code || undefined },
      });
      setCsrf(r.csrfToken);
      onDone();
    } catch (err) {
      const c = err instanceof ApiError ? err.code : "";
      if (c === "totp_required") setNeedTotp(true);
      else
        setError(
          c === "invalid_totp"
            ? t("auth.invalidTotp")
            : c === "too_many_attempts"
              ? t("auth.tooMany")
              : t("auth.invalid"),
        );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame title={t("auth.loginTitle")} subtitle={t("auth.loginSubtitle")}>
      <form className="stack" onSubmit={submit}>
        <Field label={t("auth.password")}>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </Field>
        {needTotp && (
          <Field label={t("auth.totp")}>
            <input
              className="input mono"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              autoComplete="one-time-code"
            />
          </Field>
        )}
        {error && (
          <div className="badge bad" style={{ alignSelf: "flex-start" }}>
            {error}
          </div>
        )}
        <button className="btn primary block" disabled={busy} type="submit">
          <Lock size={16} /> {t("auth.signIn")}
        </button>
      </form>
    </Frame>
  );
}
