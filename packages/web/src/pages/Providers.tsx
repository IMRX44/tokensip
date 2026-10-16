import { ExternalLink, Pencil, Plus, Server, Trash2, Zap } from "lucide-react";
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

interface ProviderDraft {
  name: string;
  apiKey: string;
  baseUrl: string;
  anthropicBaseUrl: string;
  streamUsage: boolean;
}

/** Shared form for adding and editing a provider. */
function ProviderForm({
  preset,
  draft,
  setDraft,
  editing,
}: {
  preset: CatalogProvider;
  draft: ProviderDraft;
  setDraft(d: ProviderDraft): void;
  editing: boolean;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<ProviderDraft>) => setDraft({ ...draft, ...patch });
  const isCustom = preset.requiresBaseUrl || preset.local;
  return (
    <div className="stack">
      <Field label={t("providers.name")}>
        <input
          className="input"
          value={draft.name}
          placeholder={preset.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>
      {!preset.local && (
        <Field
          label={t("providers.apiKey")}
          hint={
            editing ? (
              t("providers.apiKeyKeep")
            ) : preset.keyUrl ? (
              <a href={preset.keyUrl} target="_blank" rel="noreferrer noopener">
                {t("providers.getKey")} <ExternalLink size={11} />
              </a>
            ) : undefined
          }
        >
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            value={draft.apiKey}
            onChange={(e) => set({ apiKey: e.target.value })}
          />
        </Field>
      )}
      {(isCustom || editing) && preset.surfaces.openai && (
        <Field label={t("providers.baseUrl")} hint={t("providers.baseUrlHint")}>
          <input
            className="input mono"
            value={draft.baseUrl}
            placeholder={preset.surfaces.openai.baseUrl || "https://api.example.com/v1"}
            onChange={(e) => set({ baseUrl: e.target.value })}
          />
        </Field>
      )}
      {(isCustom || preset.surfaces.anthropic) && (
        <Field label={t("providers.anthropicBaseUrl")} hint={t("providers.anthropicBaseUrlHint")}>
          <input
            className="input mono"
            value={draft.anthropicBaseUrl}
            placeholder={preset.surfaces.anthropic?.baseUrl || "https://api.example.com"}
            onChange={(e) => set({ anthropicBaseUrl: e.target.value })}
          />
        </Field>
      )}
      {preset.surfaces.openai && (
        <div className="list-row" style={{ padding: "4px 0" }}>
          <div className="grow">
            <div style={{ fontWeight: 550 }}>{t("providers.streamUsage")}</div>
            <div className="small faint">{t("providers.streamUsageHint")}</div>
          </div>
          <Switch
            checked={draft.streamUsage}
            label={t("providers.streamUsage")}
            onChange={(v) => set({ streamUsage: v })}
          />
        </div>
      )}
    </div>
  );
}

function AddProvider({ catalog, onClose, onSaved }: { catalog: Catalog; onClose(): void; onSaved(): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [preset, setPreset] = useState<CatalogProvider | null>(null);
  const [draft, setDraft] = useState<ProviderDraft>({
    name: "",
    apiKey: "",
    baseUrl: "",
    anthropicBaseUrl: "",
    streamUsage: false,
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!preset) return;
    setBusy(true);
    try {
      await api("/providers", {
        method: "POST",
        body: {
          preset: preset.id,
          name: draft.name || preset.name,
          apiKey: draft.apiKey || null,
          baseUrl: draft.baseUrl || null,
          anthropicBaseUrl: draft.anthropicBaseUrl || null,
          streamUsage: draft.streamUsage === Boolean(preset.streamUsageDefault) ? null : draft.streamUsage,
        },
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
            <button
              key={p.id}
              type="button"
              className="preset"
              onClick={() => {
                setPreset(p);
                setDraft((d) => ({ ...d, streamUsage: Boolean(p.streamUsageDefault) }));
              }}
            >
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
            disabled={busy || (preset.requiresBaseUrl && !draft.baseUrl)}
          >
            {t("common.save")}
          </button>
        </>
      }
    >
      <ProviderForm preset={preset} draft={draft} setDraft={setDraft} editing={false} />
    </Modal>
  );
}

function EditProvider({
  p,
  preset,
  onClose,
  onSaved,
}: {
  p: ProviderRecord;
  preset: CatalogProvider;
  onClose(): void;
  onSaved(): void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [draft, setDraft] = useState<ProviderDraft>({
    name: p.name,
    apiKey: "",
    baseUrl: p.baseUrl ?? "",
    anthropicBaseUrl: p.anthropicBaseUrl ?? "",
    streamUsage: p.streamUsage ?? Boolean(preset.streamUsageDefault),
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api(`/providers/${p.id}`, {
        method: "PATCH",
        body: {
          name: draft.name || preset.name,
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
          baseUrl: draft.baseUrl || null,
          anthropicBaseUrl: draft.anthropicBaseUrl || null,
          streamUsage: draft.streamUsage === Boolean(preset.streamUsageDefault) ? null : draft.streamUsage,
        },
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

  return (
    <Modal
      title={t("providers.editTitle")}
      subtitle={preset.name}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void save()}
            disabled={busy || (preset.requiresBaseUrl && !draft.baseUrl)}
          >
            {t("common.save")}
          </button>
        </>
      }
    >
      <ProviderForm preset={preset} draft={draft} setDraft={setDraft} editing />
    </Modal>
  );
}

function ProviderRow({ p, catalog, onChange }: { p: ProviderRecord; catalog: Catalog; onChange(): void }) {
  const { t, num } = useI18n();
  const toast = useToast();
  const [test, setTest] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
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
          <button
            type="button"
            className="btn ghost sm icon-btn"
            aria-label={t("common.edit")}
            onClick={() => setEditing(true)}
          >
            <Pencil size={15} />
          </button>
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
      {editing && preset && <EditProvider p={p} preset={preset} onClose={() => setEditing(false)} onSaved={onChange} />}
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
