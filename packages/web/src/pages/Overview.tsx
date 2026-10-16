import { Activity, Coins, Gauge, Plug, Sparkles, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { AreaChart, Legend, Ring } from "../components/charts";
import { Avatar, Callout, Empty, Segmented, Skeleton } from "../components/ui";
import { useI18n } from "../i18n";
import type { Overview } from "../lib/api";
import { useApi } from "../lib/hooks";
import { navigate } from "../lib/router";

type Range = "24h" | "7d" | "30d" | "90d";

export function OverviewPage() {
  const { t, usd, compact, pct, num, date, bytes } = useI18n();
  const [range, setRange] = useState<Range>("7d");
  const { data, loading } = useApi<Overview>(`/overview?range=${range}`, [range]);

  const labels = useMemo(() => {
    if (!data) return [];
    // Fill empty buckets so the chart reads as a continuous timeline.
    const buckets: number[] = [];
    const end = Date.now();
    for (let ts = Math.floor(data.since / data.bucketMs) * data.bucketMs; ts <= end; ts += data.bucketMs)
      buckets.push(ts);
    return buckets;
  }, [data]);
  const byBucket = useMemo(() => new Map((data?.series ?? []).map((s) => [s.t, s])), [data]);
  const fmtLabel = (ts: number) =>
    range === "24h"
      ? date(ts, { hour: "2-digit", minute: "2-digit", dateStyle: undefined, timeStyle: undefined })
      : date(ts, { month: "short", day: "numeric", dateStyle: undefined, timeStyle: undefined });

  const tt = data?.totals;
  const head = (
    <div className="page-head">
      <div>
        <h1 className="page-title">{t("overview.title")}</h1>
        <p className="page-sub">{t("overview.subtitle")}</p>
      </div>
      <Segmented<Range>
        value={range}
        onChange={setRange}
        options={(["24h", "7d", "30d", "90d"] as Range[]).map((r) => ({ value: r, label: t(`range.${r}`) }))}
      />
    </div>
  );

  if (loading && !data) {
    return (
      <div className="page">
        {head}
        <div className="grid grid-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card stack">
              <Skeleton w={90} />
              <Skeleton h={34} w={140} />
              <Skeleton w={180} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (!data || !tt) return <div className="page">{head}</div>;

  if (tt.requests === 0) {
    return (
      <div className="page">
        {head}
        <div className="card">
          <Empty
            icon={<Plug size={26} />}
            title={t("overview.emptyTitle")}
            body={t("overview.emptyBody")}
            action={
              <button type="button" className="btn primary" onClick={() => navigate("/integrate")}>
                <Plug size={16} /> {t("overview.emptyCta")}
              </button>
            }
          />
        </div>
      </div>
    );
  }

  const tokensSaved = tt.optimizerSaved + tt.cacheReadTokens + tt.cacheHitTokens;
  const maxModelBaseline = Math.max(1e-9, ...data.byModel.map((m) => m.baselineCost));

  return (
    <div className="page">
      {head}
      {data.unpricedModels.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="warn">
            {t("overview.unpriced", {
              count: data.unpricedModels.length,
              models: data.unpricedModels.slice(0, 5).join(", "),
            })}{" "}
            <button
              type="button"
              className="btn sm"
              style={{ marginInlineStart: 6, height: 26 }}
              onClick={() => navigate("/settings#pricing")}
            >
              {t("overview.unpricedCta")} →
            </button>
          </Callout>
        </div>
      )}
      <div className="grid grid-4">
        <div className="card hero-card span-2">
          <div className="row between">
            <div>
              <div className="stat-label">
                <Sparkles size={14} color="var(--mint)" /> {t("overview.moneySaved")}
              </div>
              <div className="stat-value xl gradient-text">{usd(tt.saved)}</div>
              <div className="stat-hint">{t("overview.savingsRate", { rate: pct(tt.savingsRate) })}</div>
              <div className="row mt small" style={{ gap: 18 }}>
                <span className="muted">
                  {t("overview.actualSpend")} <b style={{ color: "var(--text)" }}>{usd(tt.cost)}</b>
                </span>
                <span className="faint">{t("overview.baseline", { amount: usd(tt.baselineCost) })}</span>
              </div>
            </div>
            <Ring value={tt.savingsRate} size={96} label={t("overview.savingsRate", { rate: pct(tt.savingsRate) })} />
          </div>
        </div>
        <div className="card">
          <div className="stat-label">
            <Coins size={14} /> {t("overview.tokensSaved")}
          </div>
          <div className="stat-value">{compact(tokensSaved)}</div>
          <div className="stat-hint">
            {t("overview.tokensSavedHint", {
              trimmed: compact(tt.optimizerSaved),
              cached: compact(tt.cacheReadTokens + tt.cacheHitTokens),
            })}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">
            <Activity size={14} /> {t("overview.requests")}
          </div>
          <div className="stat-value">{num(tt.requests)}</div>
          <div className="stat-hint">{t("overview.errors", { count: num(tt.errors) })}</div>
        </div>
      </div>

      <div className="grid grid-3 mt">
        <div className="card span-2">
          <div className="row between" style={{ marginBottom: 12 }}>
            <h3 className="card-title" style={{ margin: 0 }}>
              {t("overview.costChart")}
            </h3>
            <Legend
              items={[
                { label: t("overview.withoutTokensip"), color: "var(--text-3)" },
                { label: t("overview.withTokensip"), color: "#34E2A1" },
              ]}
            />
          </div>
          <AreaChart
            labels={labels.map(fmtLabel)}
            format={(v) => usd(v)}
            series={[
              {
                label: t("overview.withoutTokensip"),
                color: "#6B7D92",
                values: labels.map((b) => byBucket.get(b)?.baselineCost ?? 0),
                dashed: true,
              },
              {
                label: t("overview.withTokensip"),
                color: "#34E2A1",
                values: labels.map((b) => byBucket.get(b)?.cost ?? 0),
                fill: true,
              },
            ]}
          />
        </div>
        <div className="stack">
          <div className="card">
            <div className="stat-label">
              <Zap size={14} /> {t("overview.cacheHits")}
            </div>
            <div className="stat-value">{num(tt.cacheHits)}</div>
            <div className="stat-hint">
              {t("overview.cacheHitsHint", { hits: num(tt.cacheHits), entries: num(data.cache.entries) })} ·{" "}
              {bytes(data.cache.bytes)}
            </div>
          </div>
          <div className="card">
            <div className="stat-label">
              <Gauge size={14} /> {t("overview.overhead")}
            </div>
            <div className="stat-value">
              {num(tt.avgOverheadMs, { maximumFractionDigits: 2 })}{" "}
              <span className="faint" style={{ fontSize: 15 }}>
                ms
              </span>
            </div>
            <div className="stat-hint">{t("overview.overheadHint")}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-2 mt">
        <div className="card">
          <div className="row between" style={{ marginBottom: 12 }}>
            <h3 className="card-title" style={{ margin: 0 }}>
              {t("overview.tokensChart")}
            </h3>
            <Legend
              items={[
                { label: t("overview.promptTokens"), color: "#3EC5FF" },
                { label: t("overview.tokensSaved"), color: "#34E2A1" },
              ]}
            />
          </div>
          <AreaChart
            labels={labels.map(fmtLabel)}
            format={(v) => compact(v)}
            series={[
              {
                label: t("overview.promptTokens"),
                color: "#3EC5FF",
                values: labels.map((b) => byBucket.get(b)?.promptTokens ?? 0),
                fill: true,
              },
              {
                label: t("overview.tokensSaved"),
                color: "#34E2A1",
                values: labels.map((b) => byBucket.get(b)?.savedTokens ?? 0),
                fill: true,
              },
            ]}
          />
        </div>
        <div className="card">
          <h3 className="card-title">{t("overview.byModel")}</h3>
          <div className="stack" style={{ gap: 14 }}>
            {data.byModel.slice(0, 7).map((m) => (
              <div key={`${m.model}-${m.provider}`} className="row" style={{ gap: 12 }}>
                <Avatar id={m.provider ?? "?"} name={m.provider ?? "?"} size={30} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row between">
                    <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                      {m.model ?? "—"}
                    </span>
                    <span className="small">
                      <b>{usd(m.cost)}</b> <span className="faint">/ {usd(m.baselineCost)}</span>
                    </span>
                  </div>
                  <div className="bar-track" style={{ marginTop: 6, position: "relative" }}>
                    <div
                      style={{
                        position: "absolute",
                        insetBlock: 0,
                        insetInlineStart: 0,
                        width: `${(m.baselineCost / maxModelBaseline) * 100}%`,
                        background: "rgba(62,197,255,.22)",
                        borderRadius: 3,
                      }}
                    />
                    <div
                      className="bar-fill"
                      style={{
                        position: "absolute",
                        insetBlock: 0,
                        insetInlineStart: 0,
                        width: `${(m.cost / maxModelBaseline) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
