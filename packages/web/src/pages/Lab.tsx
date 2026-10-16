import { FlaskConical, Play } from "lucide-react";
import { useState } from "react";
import { ProfilePicker } from "../components/ProfilePicker";
import { Callout, CodeBlock, SafetyBadge, Segmented } from "../components/ui";
import { type MessageKey, useI18n } from "../i18n";
import { api, type Catalog, type OptimizeReport, type ProfileId } from "../lib/api";
import { SAMPLES } from "../lib/samples";

type Protocol = keyof typeof SAMPLES;

export function LabPage({ catalog }: { catalog: Catalog }) {
  const { t, num, pct } = useI18n();
  const [protocol, setProtocol] = useState<Protocol>("openai-chat");
  const [profile, setProfile] = useState<ProfileId>("balanced");
  const [input, setInput] = useState(() => JSON.stringify(SAMPLES["openai-chat"], null, 2));
  const [result, setResult] = useState<{ payload: unknown; report: OptimizeReport } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (p = profile) => {
    setError("");
    let payload: unknown;
    try {
      payload = JSON.parse(input);
    } catch {
      setError(t("lab.invalidJson"));
      return;
    }
    setBusy(true);
    try {
      setResult(await api("/optimize", { method: "POST", body: { protocol, payload, profile: p } }));
    } catch {
      setError(t("common.error"));
    } finally {
      setBusy(false);
    }
  };

  const r = result?.report;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("lab.title")}</h1>
          <p className="page-sub">{t("lab.subtitle")}</p>
        </div>
      </div>

      <div className="card">
        <div className="row between wrap" style={{ marginBottom: 14 }}>
          <div className="row wrap">
            <span className="label">{t("lab.protocol")}</span>
            <Segmented<Protocol>
              value={protocol}
              onChange={(p) => {
                setProtocol(p);
                setInput(JSON.stringify(SAMPLES[p], null, 2));
                setResult(null);
              }}
              options={[
                { value: "openai-chat", label: "OpenAI Chat" },
                { value: "openai-responses", label: "Responses" },
                { value: "anthropic", label: "Anthropic" },
                { value: "gemini", label: "Gemini" },
              ]}
            />
          </div>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setInput(JSON.stringify(SAMPLES[protocol], null, 2))}
          >
            <FlaskConical size={14} /> {t("lab.loadSample")}
          </button>
        </div>
        <ProfilePicker
          catalog={catalog}
          value={profile}
          compact
          onChange={(p) => {
            setProfile(p);
            void run(p);
          }}
        />
      </div>

      <div className="grid grid-2 mt">
        <div className="card stack">
          <div className="row between">
            <h3 className="card-title" style={{ margin: 0 }}>
              {t("lab.input")}
            </h3>
            <button type="button" className="btn primary sm" onClick={() => void run()} disabled={busy}>
              <Play size={14} /> {t("lab.run")}
            </button>
          </div>
          <textarea
            className="textarea"
            style={{ minHeight: 460 }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
          />
          {error && <Callout tone="bad">{error}</Callout>}
        </div>

        <div className="stack">
          {r ? (
            <>
              <div className="card">
                <div className="grid grid-4" style={{ gap: 10 }}>
                  <div>
                    <div className="stat-label">{t("lab.before")}</div>
                    <div className="stat-value" style={{ fontSize: 22 }}>
                      {num(r.tokensBefore)}
                    </div>
                  </div>
                  <div>
                    <div className="stat-label">{t("lab.after")}</div>
                    <div className="stat-value" style={{ fontSize: 22 }}>
                      {num(r.tokensAfter)}
                    </div>
                  </div>
                  <div>
                    <div className="stat-label">{t("lab.reduction")}</div>
                    <div
                      className={`stat-value ${r.lossy ? "" : "gradient-text"}`}
                      style={{ fontSize: 22, color: r.lossy ? "var(--rose)" : undefined }}
                    >
                      {pct(r.tokensBefore ? r.tokensSaved / r.tokensBefore : 0)}
                    </div>
                  </div>
                  <div>
                    <div className="stat-label">{t("lab.time")}</div>
                    <div className="stat-value" style={{ fontSize: 22 }}>
                      {num(r.durationMs, { maximumFractionDigits: 1 })}
                      <span className="faint" style={{ fontSize: 13 }}>
                        {" "}
                        ms
                      </span>
                    </div>
                  </div>
                </div>
                {r.lossy && (
                  <div className="mt">
                    <Callout tone="bad" title={t("profile.warnTitle")}>
                      {t(`profile.${profile}.desc`)}
                    </Callout>
                  </div>
                )}
                {!r.changed && (
                  <div className="mt">
                    <Callout>{t("lab.noChange")}</Callout>
                  </div>
                )}
                <h3 className="card-title mt">{t("lab.stages")}</h3>
                <div>
                  {r.stages.map((s) => (
                    <div key={s.id} className="list-row" style={{ padding: "8px 0" }}>
                      <span className="dot" style={{ color: s.applied ? "var(--mint)" : "var(--surface-3)" }} />
                      <span className="grow">{t(`stage.${s.id}` as MessageKey)}</span>
                      <SafetyBadge safety={s.safety} />
                      <span
                        className="mono small"
                        style={{
                          minWidth: 70,
                          textAlign: "end",
                          color: s.tokensSaved ? "var(--mint)" : "var(--text-3)",
                        }}
                      >
                        {s.tokensSaved ? `−${num(s.tokensSaved)}` : s.applied ? "✓" : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="card">
                <h3 className="card-title">{t("lab.output")}</h3>
                <div style={{ maxHeight: 420, overflow: "auto" }}>
                  <CodeBlock code={JSON.stringify(result?.payload, null, 2)} />
                </div>
              </div>
            </>
          ) : (
            <div className="card" style={{ display: "grid", placeItems: "center", minHeight: 300 }}>
              <button type="button" className="btn primary" onClick={() => void run()} disabled={busy}>
                <Play size={16} /> {t("lab.run")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
