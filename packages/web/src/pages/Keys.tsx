import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Callout, CopyButton, Empty, Field, Modal, Switch, useToast } from "../components/ui";
import { useI18n } from "../i18n";
import { type ApiKey, api, type Catalog, type ProfileId } from "../lib/api";
import { useApi } from "../lib/hooks";

function CreateKey({
  catalog,
  onClose,
  onCreated,
}: {
  catalog: Catalog;
  onClose(): void;
  onCreated(key: string): void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [profile, setProfile] = useState<ProfileId | "">("");
  const [budget, setBudget] = useState("");
  const [rpm, setRpm] = useState("");
  const [providers, setProviders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<ApiKey & { key: string }>("/keys", {
        method: "POST",
        body: {
          name,
          profile: profile || null,
          monthlyBudgetUsd: budget ? Number(budget) : null,
          rpm: rpm ? Number(rpm) : null,
          allowedProviders: providers.length ? providers : null,
        },
      });
      onCreated(r.key);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("keys.create")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" disabled={!name || busy} onClick={() => void create()}>
            {t("common.create")}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label={t("keys.name")}>
          <input
            className="input"
            value={name}
            placeholder={t("keys.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label={t("keys.profile")}>
          <select className="select" value={profile} onChange={(e) => setProfile(e.target.value as ProfileId | "")}>
            <option value="">{t("common.default")}</option>
            {catalog.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {t(`profile.${p.id}`)}
              </option>
            ))}
          </select>
        </Field>
        {(profile === "aggressive" || profile === "extreme") && (
          <Callout tone={profile === "extreme" ? "bad" : "warn"} title={t("profile.warnTitle")}>
            {t(`profile.${profile}.desc`)}
          </Callout>
        )}
        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field label={t("keys.budget")} hint={t("common.optional")}>
            <input
              className="input"
              type="number"
              min={0}
              step="0.01"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="∞"
            />
          </Field>
          <Field label={t("keys.rpm")} hint={t("common.optional")}>
            <input
              className="input"
              type="number"
              min={1}
              value={rpm}
              onChange={(e) => setRpm(e.target.value)}
              placeholder="∞"
            />
          </Field>
        </div>
        <Field label={t("keys.providers")} hint={providers.length ? undefined : t("keys.allProviders")}>
          <div className="row wrap" style={{ gap: 6 }}>
            {catalog.providers.map((p) => {
              const on = providers.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`badge ${on ? "ok" : ""}`}
                  style={{ cursor: "pointer" }}
                  onClick={() => setProviders((cur) => (on ? cur.filter((x) => x !== p.id) : [...cur, p.id]))}
                >
                  {p.name}
                </button>
              );
            })}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

export function KeysPage({ catalog }: { catalog: Catalog }) {
  const { t, usd, date } = useI18n();
  const toast = useToast();
  const { data, reload } = useApi<ApiKey[]>("/keys");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("keys.title")}</h1>
          <p className="page-sub">{t("keys.subtitle")}</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={16} /> {t("keys.create")}
        </button>
      </div>

      <div className="card">
        {data && data.length === 0 ? (
          <Empty icon={<KeyRound size={24} />} title={t("keys.none")} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("keys.name")}</th>
                  <th>{t("lab.profile")}</th>
                  <th>{t("keys.spend")}</th>
                  <th className="num">{t("keys.rpm")}</th>
                  <th>{t("keys.lastUsed")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data?.map((k) => {
                  const ratio = k.monthlyBudgetUsd ? Math.min(1, k.monthSpend / k.monthlyBudgetUsd) : 0;
                  return (
                    <tr key={k.id}>
                      <td>
                        <b>{k.name}</b>
                        <div className="mono small faint">{k.hint}</div>
                      </td>
                      <td>
                        {k.profile ? (
                          <span
                            className={`badge ${k.profile === "extreme" ? "bad" : k.profile === "aggressive" ? "warn" : "info"}`}
                          >
                            {t(`profile.${k.profile}`)}
                          </span>
                        ) : (
                          <span className="faint">{t("common.default")}</span>
                        )}
                      </td>
                      <td style={{ minWidth: 160 }}>
                        <div className="small">
                          {usd(k.monthSpend)}{" "}
                          <span className="faint">
                            / {k.monthlyBudgetUsd !== null ? usd(k.monthlyBudgetUsd) : t("common.unlimited")}
                          </span>
                        </div>
                        {k.monthlyBudgetUsd !== null && (
                          <div className="bar-track" style={{ marginTop: 4 }}>
                            <div
                              className="bar-fill"
                              style={{ width: `${ratio * 100}%`, background: ratio > 0.9 ? "var(--rose)" : undefined }}
                            />
                          </div>
                        )}
                      </td>
                      <td className="num">{k.rpm ?? "∞"}</td>
                      <td className="faint">{k.lastUsedAt ? date(k.lastUsedAt) : t("keys.never")}</td>
                      <td>
                        <div className="row" style={{ justifyContent: "flex-end" }}>
                          <Switch
                            checked={k.enabled}
                            label={t("common.enabled")}
                            onChange={async (v) => {
                              await api(`/keys/${k.id}`, { method: "PATCH", body: { enabled: v } });
                              void reload();
                            }}
                          />
                          <button
                            type="button"
                            className="btn ghost sm icon-btn"
                            aria-label={t("common.delete")}
                            onClick={async () => {
                              if (!window.confirm(t("common.confirmDelete"))) return;
                              await api(`/keys/${k.id}`, { method: "DELETE" });
                              toast(t("common.saved"));
                              void reload();
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating && (
        <CreateKey
          catalog={catalog}
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            setCreated(key);
            void reload();
          }}
        />
      )}
      {created && (
        <Modal title={t("keys.createdTitle")} subtitle={t("keys.createdBody")} onClose={() => setCreated(null)}>
          <div className="code" style={{ padding: "14px 16px" }}>
            <div className="row between">
              <code style={{ fontSize: 14, wordBreak: "break-all" }}>{created}</code>
              <CopyButton text={created} label />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
