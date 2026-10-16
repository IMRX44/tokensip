import { Database, Gauge, Palette, Route, Shield, SlidersHorizontal } from "lucide-react";
import QRCode from "qrcode";
import { type ReactNode, useEffect, useState } from "react";
import { ProfilePicker } from "../components/ProfilePicker";
import { Callout, Field, SafetyBadge, Segmented, Switch, useToast } from "../components/ui";
import { LANGUAGES, type MessageKey, useI18n } from "../i18n";
import { ApiError, type AuthState, api, type Catalog, type Settings, setCsrf } from "../lib/api";
import { useApi } from "../lib/hooks";
import { type ThemePref, useTheme } from "../lib/theme";

function Section({
  icon,
  title,
  body,
  children,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  children: ReactNode;
}) {
  return (
    <div className="card">
      <h3 className="card-title">
        {icon} {title}
      </h3>
      {body && <p className="card-sub">{body}</p>}
      {children}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="list-row" style={{ padding: "10px 0" }}>
      <div className="grow">
        <div style={{ fontWeight: 550 }}>{label}</div>
        {hint && <div className="small faint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function NumberInput({
  value,
  onCommit,
  min,
  max,
  step,
}: {
  value: number;
  onCommit(v: number): void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <input
      className="input"
      style={{ width: 120 }}
      type="number"
      min={min}
      max={max}
      step={step}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const n = Number(v);
        if (Number.isFinite(n) && n !== value) onCommit(n);
      }}
    />
  );
}

function Security({ auth, onAuthChange }: { auth: AuthState; onAuthChange(): void }) {
  const { t, date } = useI18n();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [totp, setTotp] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const audit = useApi<{ id: number; ts: number; action: string; ip: string | null }[]>("/audit?limit=12");

  const changePassword = async () => {
    try {
      const r = await api<{ csrfToken: string }>("/auth/password", { method: "POST", body: { current, next } });
      setCsrf(r.csrfToken);
      setCurrent("");
      setNext("");
      toast(t("settings.passwordChanged"));
    } catch (e) {
      toast(
        e instanceof ApiError && e.code === "invalid_credentials" ? t("auth.invalid") : t("auth.passwordHint"),
        "bad",
      );
    }
  };

  const beginTotp = async () => {
    const r = await api<{ secret: string; uri: string }>("/auth/totp/begin", { method: "POST" });
    setTotp({ secret: r.secret, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 180 }) });
  };

  return (
    <Section icon={<Shield size={16} />} title={t("settings.security")}>
      <div className="grid grid-2">
        <div className="stack">
          <b>{t("settings.changePassword")}</b>
          <Field label={t("settings.currentPassword")}>
            <input
              className="input"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <Field label={t("settings.newPassword")} hint={t("auth.passwordHint")}>
            <input
              className="input"
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <button
            type="button"
            className="btn"
            style={{ alignSelf: "flex-start" }}
            disabled={!current || next.length < 10}
            onClick={() => void changePassword()}
          >
            {t("common.save")}
          </button>
        </div>
        <div className="stack">
          <b>{t("settings.twoFactor")}</b>
          <p className="muted small" style={{ margin: 0 }}>
            {auth.totpEnabled ? t("settings.twoFactorOn") : t("settings.twoFactorOff")}
          </p>
          {auth.totpEnabled ? (
            <button
              type="button"
              className="btn danger"
              style={{ alignSelf: "flex-start" }}
              onClick={async () => {
                const password = window.prompt(t("settings.currentPassword"));
                if (!password) return;
                try {
                  await api("/auth/totp/disable", { method: "POST", body: { password } });
                  onAuthChange();
                } catch {
                  toast(t("auth.invalid"), "bad");
                }
              }}
            >
              {t("settings.twoFactorDisable")}
            </button>
          ) : totp ? (
            <div className="stack">
              <p className="small muted" style={{ margin: 0 }}>
                {t("settings.twoFactorScan")}
              </p>
              <div className="row" style={{ alignItems: "flex-start" }}>
                <img
                  src={totp.qr}
                  width={150}
                  height={150}
                  alt="TOTP QR"
                  style={{ borderRadius: 10, background: "#fff" }}
                />
                <code className="small" style={{ wordBreak: "break-all" }}>
                  {totp.secret}
                </code>
              </div>
              <div className="row">
                <input
                  className="input mono"
                  style={{ width: 140 }}
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                />
                <button
                  type="button"
                  className="btn primary"
                  disabled={code.length !== 6}
                  onClick={async () => {
                    try {
                      await api("/auth/totp/enable", { method: "POST", body: { code } });
                      setTotp(null);
                      onAuthChange();
                    } catch {
                      toast(t("auth.invalidTotp"), "bad");
                    }
                  }}
                >
                  {t("settings.twoFactorEnable")}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={() => void beginTotp()}>
              {t("settings.twoFactorSetup")}
            </button>
          )}
        </div>
      </div>
      <h4 className="card-title mt-lg">{t("settings.audit")}</h4>
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {audit.data?.map((a) => (
              <tr key={a.id}>
                <td className="faint">{date(a.ts)}</td>
                <td>
                  <code>{a.action}</code>
                </td>
                <td className="faint mono small">{a.ip ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

export function SettingsPage({
  catalog,
  auth,
  onAuthChange,
}: {
  catalog: Catalog;
  auth: AuthState;
  onAuthChange(): void;
}) {
  const { t, lang, setLang, pct, num, bytes } = useI18n();
  const toast = useToast();
  const [theme, setTheme] = useTheme();
  const { data: s, setData } = useApi<Settings>("/settings");
  const cache = useApi<{ entries: number; bytes: number }>("/cache");

  const save = async (patch: Partial<Settings>) => {
    try {
      const next = await api<Settings>("/settings", { method: "PUT", body: patch });
      setData(next);
      toast(t("common.saved"));
    } catch {
      toast(t("common.error"), "bad");
    }
  };
  if (!s) return <div className="page" />;

  const profileStages = new Set(catalog.profiles.find((p) => p.id === s.profile)?.stages ?? []);
  const stageOn = (id: string) => (id in s.overrides ? Boolean(s.overrides[id]) : profileStages.has(id));
  const opt = (k: string) => Number(s.stageOptions[k] ?? catalog.stageDefaults[k] ?? 0);
  const lossyActive = catalog.stages.some((st) => st.safety === "lossy" && stageOn(st.id));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("settings.title")}</h1>
        </div>
      </div>

      <div className="stack" style={{ gap: 16 }}>
        <Section icon={<Gauge size={16} />} title={t("settings.optimization")} body={t("settings.optimizationBody")}>
          <ProfilePicker
            catalog={catalog}
            value={s.profile}
            onChange={(profile) => void save({ profile, overrides: {} })}
          />
        </Section>

        <Section icon={<SlidersHorizontal size={16} />} title={t("settings.stages")} body={t("settings.stagesBody")}>
          {catalog.stages.map((st) => (
            <Row key={st.id} label={t(`stage.${st.id}` as MessageKey)} hint={st.description}>
              <SafetyBadge safety={st.safety} />
              <Switch
                checked={stageOn(st.id)}
                label={st.id}
                onChange={(v) => {
                  const overrides = { ...s.overrides };
                  if (v === profileStages.has(st.id)) delete overrides[st.id];
                  else overrides[st.id] = v;
                  void save({ overrides });
                }}
              />
            </Row>
          ))}
        </Section>

        {lossyActive && (
          <Section icon={<SlidersHorizontal size={16} />} title={t("settings.extremeTuning")}>
            <Callout tone="warn">{t("profile.aggressive.desc")}</Callout>
            <Row label={t("settings.targetRatio")} hint={t("settings.targetRatioHint")}>
              <input
                type="range"
                min={0.02}
                max={1}
                step={0.01}
                defaultValue={opt("targetRatio")}
                onMouseUp={(e) =>
                  void save({ stageOptions: { targetRatio: Number((e.target as HTMLInputElement).value) } })
                }
                onKeyUp={(e) =>
                  void save({ stageOptions: { targetRatio: Number((e.target as HTMLInputElement).value) } })
                }
                style={{ width: 180, accentColor: "var(--rose)" }}
              />
              <b style={{ minWidth: 48 }}>{pct(opt("targetRatio"))}</b>
            </Row>
            <Row label={t("settings.maxOutput")}>
              <NumberInput
                value={opt("maxOutputTokens")}
                min={16}
                onCommit={(v) => void save({ stageOptions: { maxOutputTokens: v } })}
              />
            </Row>
            <Row label={t("settings.maxMessages")}>
              <NumberInput
                value={opt("maxMessages")}
                min={4}
                onCommit={(v) => void save({ stageOptions: { maxMessages: v } })}
              />
            </Row>
            <Row label={t("settings.keepSteps")}>
              <NumberInput
                value={opt("keepRecentSteps")}
                min={1}
                onCommit={(v) => void save({ stageOptions: { keepRecentSteps: v } })}
              />
            </Row>
            <Row label={t("settings.reasoning")}>
              <select
                className="select"
                style={{ width: 140 }}
                value={String(s.stageOptions.reasoningEffort ?? catalog.stageDefaults.reasoningEffort)}
                onChange={(e) => void save({ stageOptions: { reasoningEffort: e.target.value } })}
              >
                {["minimal", "low", "medium"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Row>
          </Section>
        )}

        <div className="grid grid-2">
          <Section icon={<Database size={16} />} title={t("settings.cache")} body={t("settings.cacheBody")}>
            <Row label={t("settings.cacheEnabled")}>
              <Switch
                checked={s.responseCache.enabled}
                onChange={(v) => void save({ responseCache: { ...s.responseCache, enabled: v } })}
              />
            </Row>
            <Row label={t("settings.cacheDeterministic")}>
              <Switch
                checked={s.responseCache.onlyDeterministic}
                onChange={(v) => void save({ responseCache: { ...s.responseCache, onlyDeterministic: v } })}
              />
            </Row>
            <Row label={t("settings.cacheTtl")}>
              <NumberInput
                value={s.responseCache.ttlSeconds}
                min={10}
                onCommit={(v) => void save({ responseCache: { ...s.responseCache, ttlSeconds: v } })}
              />
            </Row>
            <div className="row between mt">
              <span className="small faint">
                {cache.data &&
                  t("settings.cacheStats", { entries: num(cache.data.entries), size: bytes(cache.data.bytes) })}
              </span>
              <button
                type="button"
                className="btn sm danger"
                onClick={async () => {
                  await api("/cache", { method: "DELETE" });
                  toast(t("settings.cacheCleared"));
                  void cache.reload();
                }}
              >
                {t("settings.cacheClear")}
              </button>
            </div>
          </Section>

          <Section icon={<Route size={16} />} title={t("settings.routing")}>
            <Row label={t("settings.defaultProvider")} hint={t("settings.defaultProviderHint")}>
              <select
                className="select"
                style={{ width: 170 }}
                value={s.defaultProvider ?? ""}
                onChange={(e) => void save({ defaultProvider: e.target.value || null })}
              >
                <option value="">{t("common.none")}</option>
                {catalog.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t("settings.streamUsage")} hint={t("settings.streamUsageHint")}>
              <Switch checked={s.streamUsage} onChange={(v) => void save({ streamUsage: v })} />
            </Row>
            <Row label={t("settings.profileHeader")}>
              <Switch checked={s.allowProfileHeader} onChange={(v) => void save({ allowProfileHeader: v })} />
            </Row>
            <Row label={t("settings.retention")}>
              <NumberInput value={s.retentionDays} min={1} onCommit={(v) => void save({ retentionDays: v })} />
            </Row>
          </Section>
        </div>

        <Security auth={auth} onAuthChange={onAuthChange} />

        <Section icon={<Palette size={16} />} title={t("settings.appearance")}>
          <Row label={t("settings.language")}>
            <Segmented
              value={lang}
              onChange={setLang}
              options={LANGUAGES.map((l) => ({ value: l.id, label: l.label }))}
            />
          </Row>
          <Row label={t("settings.theme")}>
            <Segmented<ThemePref>
              value={theme}
              onChange={setTheme}
              options={(["system", "dark", "light"] as ThemePref[]).map((v) => ({ value: v, label: t(`theme.${v}`) }))}
            />
          </Row>
        </Section>
      </div>
    </div>
  );
}
