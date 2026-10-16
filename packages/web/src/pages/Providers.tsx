import { ExternalLink, Plus, Server, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import { Avatar, CopyButton, Empty, Field, Modal, Switch, useToast } from "../components/ui";
import { useI18n } from "../i18n";
import { ApiError, api, type Catalog, type CatalogProvider, type ProviderRecord } from "../lib/api";
import { useApi } from "../lib/hooks";

export function gatewayBase(): string {
  return window.location.origin;
}

export function endpointFor(p: Pick<CatalogProvider, "id" | "surfaces">): {
  openai?: string;
  anthropic?: string;
  gemini?: string;
} {
  const base = `${gatewayBase()}/${p.id}`;
  return {
    openai: p.surfaces.openai ? `${base}/v1` : undefined,
    anthropic: p.surfaces.anthropic ? base : undefined,
    gemini: p.surfaces.gemini ? base : undefined,
  };
}

function AddProvider({ catalog, onClose, onSaved }: { catalog: Catalog; onClose(): void; onSaved(): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [preset, setPreset] = useState<CatalogProvider | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!preset) return;
    setBusy(true);
    try {
      await api("/providers", {
        method: "POST",
        body: { preset: preset.id, name: name || preset.name, apiKey: apiKey || null, baseUrl: baseUrl || null },
      });
      toast(t("common.saved"));
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.code : t("common.error"), "bad");
    } finally {
      setBusy(false);
    }
  };

  if (!preset) {
    return (
      <Modal title={t("providers.choose")} onClose={onClose} wide>
        <div className="preset-grid">
          {catalog.providers.map((p) => (
            <button key={p.id} type="button" className="preset" onClick={() => setPreset(p)}>
              <Avatar id={p.id} name={p.name} />
              <span style={{ minWidth: 0 }}>
                {p.name}
                {p.local && (
                  <span className="badge" style={{ marginInlineStart: 6 }}>
                    {t("providers.local")}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={preset.name}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={() => setPreset(null)}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void save()}
            disabled={busy || (preset.requiresBaseUrl && !baseUrl)}
          >
            {t("common.save")}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label={t("providers.name")}>
          <input className="input" value={name} placeholder={preset.name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {!preset.local && (
          <Field
            label={t("providers.apiKey")}
            hint={
              preset.keyUrl && (
                <a href={preset.keyUrl} target="_blank" rel="noreferrer noopener">
                  {t("providers.getKey")} <ExternalLink size={11} />
                </a>
              )
            }
          >
            <input
              className="input mono"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
        )}
        {(preset.requiresBaseUrl || preset.local) && (
          <Field label={t("providers.baseUrl")} hint={t("providers.baseUrlHint")}>
            <input
              className="input mono"
              value={baseUrl}
              placeholder={preset.surfaces.openai?.baseUrl || "https://example.com/v1"}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function ProviderRow({ p, catalog, onChange }: { p: ProviderRecord; catalog: Catalog; onChange(): void }) {
  const { t, num } = useI18n();
  const toast = useToast();
  const [test, setTest] = useState<string | null>(null);
  const preset = catalog.providers.find((c) => c.id === p.preset);

  const runTest = async () => {
    setTest("…");
    const r = await api<{ ok: boolean; status: number; latencyMs?: number; models?: number; message?: string }>(
      `/providers/${p.id}/test`,
      { method: "POST" },
    );
    setTest(
      r.ok
        ? t("providers.testOk", { models: num(r.models ?? 0), ms: num(r.latencyMs ?? 0) })
        : t("providers.testFail", { message: r.message ?? `HTTP ${r.status}` }),
    );
  };

  return (
    <div className="list-row">
      <Avatar id={p.preset} name={preset?.name ?? p.name} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 8 }}>
          <b>{p.name}</b>
          {p.source === "env" && <span className="badge info">{t("providers.fromEnv")}</span>}
          {p.keyHint && <span className="mono small faint">{p.keyHint}</span>}
        </div>
        <div className="small faint mono" style={{ marginTop: 2 }}>
          {preset && (endpointFor(preset).openai ?? endpointFor(preset).anthropic)}
        </div>
        {test && <div className={`small ${test.startsWith("✗") ? "" : "muted"}`}>{test}</div>}
      </div>
      <button type="button" className="btn sm" onClick={() => void runTest()}>
        <Zap size={13} /> {t("common.test")}
      </button>
      {p.source === "db" && (
        <>
          <Switch
            checked={p.enabled}
            label={t("common.enabled")}
            onChange={async (v) => {
              await api(`/providers/${p.id}`, { method: "PATCH", body: { enabled: v } });
              onChange();
            }}
          />
          <button
            type="button"
            className="btn ghost sm icon-btn"
            aria-label={t("common.delete")}
            onClick={async () => {
              if (!window.confirm(t("common.confirmDelete"))) return;
              await api(`/providers/${p.id}`, { method: "DELETE" });
              toast(t("common.saved"));
              onChange();
            }}
          >
            <Trash2 size={15} />
          </button>
        </>
      )}
    </div>
  );
}

export function ProvidersPage({ catalog }: { catalog: Catalog }) {
  const { t } = useI18n();
  const { data, reload } = useApi<ProviderRecord[]>("/providers");
  const [adding, setAdding] = useState(false);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("providers.title")}</h1>
          <p className="page-sub">{t("providers.subtitle")}</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={16} /> {t("providers.add")}
        </button>
      </div>

      <div className="card">
        <h3 className="card-title">{t("providers.configured")}</h3>
        {data && data.length === 0 && <Empty icon={<Server size={24} />} title={t("providers.none")} />}
        {data?.map((p) => (
          <ProviderRow key={p.id} p={p} catalog={catalog} onChange={reload} />
        ))}
      </div>

      <div className="card mt">
        <h3 className="card-title">{t("providers.catalog")}</h3>
        <p className="card-sub">{t("providers.catalogHint")}</p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("overview.provider")}</th>
                <th>{t("providers.formats")}</th>
                <th>{t("providers.endpoint")}</th>
              </tr>
            </thead>
            <tbody>
              {catalog.providers.map((p) => {
                const e = endpointFor(p);
                const urls = [e.openai, e.anthropic && e.anthropic !== e.openai ? e.anthropic : undefined].filter(
                  Boolean,
                ) as string[];
                return (
                  <tr key={p.id}>
                    <td>
                      <div className="row">
                        <Avatar id={p.id} name={p.name} size={26} />
                        {p.name}
                      </div>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        {p.surfaces.openai && <span className="badge">OpenAI</span>}
                        {p.surfaces.anthropic && <span className="badge violet">Anthropic</span>}
                        {p.surfaces.gemini && <span className="badge info">Gemini</span>}
                      </div>
                    </td>
                    <td>
                      {urls.map((u) => (
                        <div key={u} className="row" style={{ gap: 4 }}>
                          <code>{u}</code>
                          <CopyButton text={u} />
                        </div>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {adding && <AddProvider catalog={catalog} onClose={() => setAdding(false)} onSaved={reload} />}
    </div>
  );
}
