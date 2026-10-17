import { List } from "lucide-react";
import { useEffect, useState } from "react";
import { Empty, Segmented, Skeleton } from "../components/ui";
import { useI18n } from "../i18n";
import { api, type RequestItem } from "../lib/api";

type Filter = "all" | "ok" | "error";

export function RequestsPage() {
  const { t, num, usd, date, compact } = useI18n();
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<RequestItem[] | null>(null);
  const [next, setNext] = useState<number | null>(null);

  const load = async (before?: number) => {
    const q = new URLSearchParams({ limit: "50" });
    if (filter !== "all") q.set("status", filter);
    if (before) q.set("before", String(before));
    const r = await api<{ items: RequestItem[]; nextBefore: number | null }>(`/requests?${q}`);
    setItems((cur) => (before && cur ? [...cur, ...r.items] : r.items));
    setNext(r.nextBefore);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the filter changes
  useEffect(() => {
    setItems(null);
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [filter]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("requests.title")}</h1>
          <p className="page-sub">{t("requests.subtitle")}</p>
        </div>
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: t("requests.all") },
            { value: "ok", label: t("requests.ok") },
            { value: "error", label: t("requests.errorsOnly") },
          ]}
        />
      </div>
      <div className="card">
        {!items ? (
          <div className="stack">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} h={28} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <Empty icon={<List size={24} />} title={t("requests.empty")} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("requests.time")}</th>
                  <th>{t("overview.model")}</th>
                  <th>{t("requests.status")}</th>
                  <th className="num">{t("requests.tokens")}</th>
                  <th className="num">{t("requests.saved")}</th>
                  <th className="num">{t("requests.cost")}</th>
                  <th className="num">{t("requests.latency")}</th>
                  <th>{t("requests.key")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const prompt = r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
                  const saved = r.baselineCost - r.cost;
                  return (
                    <tr key={r.id} title={r.error ?? undefined}>
                      <td className="faint">{date(r.ts, { dateStyle: "short", timeStyle: "medium" })}</td>
                      <td>
                        <div className="mono">{r.model ?? r.path}</div>
                        <div className="row small faint" style={{ gap: 6, marginTop: 2 }}>
                          {r.provider}
                          {r.stream && <span className="badge">{t("requests.stream")}</span>}
                          {r.cacheHit && <span className="badge ok">{t("requests.cacheHit")}</span>}
                          {r.lossy && <span className="badge bad">{t("requests.lossy")}</span>}
                          {r.profile && r.profile !== "balanced" && !r.lossy && (
                            <span className="badge info">{r.profile}</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${r.status < 400 ? "ok" : r.status === 429 ? "warn" : "bad"}`}>
                          <span className="dot" />
                          {r.status}
                        </span>
                      </td>
                      <td className="num">
                        {num(prompt)} / {num(r.outputTokens)}
                        {r.cacheReadTokens > 0 && (
                          <div className="small faint">⚡ {compact(r.cacheReadTokens)} cached</div>
                        )}
                        {r.estimated && <div className="small faint">{t("requests.estimated")}</div>}
                      </td>
                      <td className="num">
                        {r.optimizerSaved > 0 ? (
                          <span style={{ color: "var(--mint)" }}>−{num(r.optimizerSaved)}</span>
                        ) : (
                          <span className="faint">0</span>
                        )}
                      </td>
                      <td className="num">
                        {usd(r.cost)}
                        {saved > 0.000001 && (
                          <div className="small" style={{ color: "var(--mint)" }}>
                            −{usd(saved)}
                          </div>
                        )}
                      </td>
                      <td className="num">
                        {num(r.latencyMs)} ms
                        {r.overheadMs > 0 && (
                          <div className="small faint">+{num(r.overheadMs, { maximumFractionDigits: 2 })} ms</div>
                        )}
                      </td>
                      <td className="faint">{r.key ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {next && (
          <div className="row" style={{ justifyContent: "center", marginTop: 14 }}>
            <button type="button" className="btn" onClick={() => void load(next)}>
              {t("common.loadMore")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
