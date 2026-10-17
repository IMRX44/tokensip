import { ArrowLeft, CalendarClock, CircleAlert, Layers, Scissors, Timer, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Legend, Ring } from "../components/charts";
import { Empty, Segmented, Skeleton } from "../components/ui";
import { useI18n } from "../i18n";
import { leakRepairable, type SessionDetail, type SessionSummary, type SessionTurn } from "../lib/api";
import { useApi } from "../lib/hooks";
import { navigate } from "../lib/router";

type Range = "24h" | "7d" | "30d" | "90d";

const promptOf = (x: SessionTurn) => x.inputTokens + x.cacheReadTokens + x.cacheWriteTokens;

export function SessionsPage({ id }: { id: string | null }) {
  return id ? <SessionView id={id} /> : <SessionList />;
}

function SessionList() {
  const { t, num, usd, date, compact, pct } = useI18n();
  const [range, setRange] = useState<Range>("7d");
  const { data } = useApi<SessionSummary[]>(`/sessions?range=${range}`, [range]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("sessions.title")}</h1>
          <p className="page-sub">{t("sessions.subtitle")}</p>
        </div>
        <Segmented<Range>
          value={range}
          onChange={setRange}
          options={(["24h", "7d", "30d", "90d"] as Range[]).map((r) => ({ value: r, label: t(`range.${r}`) }))}
        />
      </div>
      <div className="card">
        {!data ? (
          <div className="stack">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} h={28} />
            ))}
          </div>
        ) : data.length === 0 ? (
          <Empty icon={<Layers size={24} />} title={t("sessions.empty")} />
        ) : (
          <div className="table-wrap">
            <table className="table clickable">
              <thead>
                <tr>
                  <th>{t("requests.time")}</th>
                  <th>{t("overview.model")}</th>
                  <th className="num">{t("sessions.turns")}</th>
                  <th>{t("sessions.fromCache")}</th>
                  <th className="num">{t("sessions.removed")}</th>
                  <th>{t("sessions.leaks")}</th>
                  <th>{t("sessions.scheduler")}</th>
                  <th className="num">{t("requests.cost")}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((s) => {
                  const open = () => navigate(`/sessions/${encodeURIComponent(s.id)}`);
                  return (
                    <tr
                      key={s.id}
                      tabIndex={0}
                      onClick={open}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          open();
                        }
                      }}
                    >
                      <td className="faint">{date(s.lastTs, { dateStyle: "short", timeStyle: "short" })}</td>
                      <td>
                        <div className="mono">{s.model ?? "—"}</div>
                        <div className="small faint">
                          {s.provider ?? "—"} · {s.key}
                        </div>
                      </td>
                      <td className="num">{num(s.turns)}</td>
                      <td style={{ minWidth: 140 }}>
                        <div className="row" style={{ gap: 8 }}>
                          <div className="bar-track grow">
                            <div className="bar-fill" style={{ width: `${Math.min(100, s.cacheReadShare * 100)}%` }} />
                          </div>
                          <span className="small" style={{ minWidth: 42, textAlign: "end" }}>
                            {pct(s.cacheReadShare)}
                          </span>
                        </div>
                        <div className="small faint">
                          {compact(s.cacheReadTokens)} / {compact(s.promptTokens)}
                        </div>
                      </td>
                      <td className="num">
                        {s.optimizerSaved > 0 ? (
                          <span dir="ltr" style={{ color: "var(--mint)" }}>
                            −{compact(s.optimizerSaved)}
                          </span>
                        ) : (
                          <span className="faint">0</span>
                        )}
                      </td>
                      <td>
                        {s.leaks > 0 ? (
                          <span className="badge bad">
                            <span className="dot" />
                            {num(s.leaks)}
                          </span>
                        ) : (
                          <span className="badge ok">0</span>
                        )}
                      </td>
                      <td>
                        <div className="row wrap" style={{ gap: 4 }}>
                          {s.applied > 0 && (
                            <span className="badge violet">{t("sessions.applied", { n: num(s.applied) })}</span>
                          )}
                          {s.deferred > 0 && (
                            <span className="badge warn">{t("sessions.deferred", { n: num(s.deferred) })}</span>
                          )}
                          {s.applied === 0 && s.deferred === 0 && <span className="faint">—</span>}
                        </div>
                      </td>
                      <td className="num">
                        {usd(s.cost)}
                        {s.baselineCost - s.cost > 0.000001 && (
                          <div className="small faint">/ {usd(s.baselineCost)}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SessionView({ id }: { id: string }) {
  const { t, num, usd, compact, pct } = useI18n();
  const { data, error } = useApi<SessionDetail>(`/sessions/${encodeURIComponent(id)}`, [id]);

  const back = (
    <button type="button" className="btn sm" onClick={() => navigate("/sessions")}>
      <ArrowLeft size={15} className="flip-rtl" /> {t("sessions.back")}
    </button>
  );

  if (error) {
    return (
      <div className="page">
        <div className="page-head">{back}</div>
        <div className="card">
          <Empty icon={<Layers size={24} />} title={t("sessions.empty")} />
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page">
        <div className="page-head">{back}</div>
        <div className="card stack">
          <Skeleton h={180} />
        </div>
      </div>
    );
  }

  const turns = data.turns;
  const prompt = turns.reduce((a, x) => a + promptOf(x), 0);
  const cached = turns.reduce((a, x) => a + x.cacheReadTokens, 0);
  const share = prompt > 0 ? cached / prompt : 0;
  const cost = turns.reduce((a, x) => a + x.cost, 0);
  const baseline = turns.reduce((a, x) => a + x.baselineCost, 0);
  const removed = turns.reduce((a, x) => a + x.optimizerSaved, 0);
  const leaks = turns.filter((x) => x.leak).length;
  const model = turns[turns.length - 1]?.model ?? "—";

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div style={{ marginBottom: 10 }}>{back}</div>
          <h1 className="page-title mono" style={{ fontSize: 22 }}>
            {model}
          </h1>
          <p className="page-sub mono small">{id}</p>
        </div>
      </div>

      <div className="grid grid-4">
        <div className="card">
          <div className="row between">
            <div>
              <div className="stat-label">
                <Zap size={14} /> {t("sessions.fromCache")}
              </div>
              <div className="stat-value">{pct(share)}</div>
              <div className="stat-hint">
                {compact(cached)} / {compact(prompt)}
              </div>
            </div>
            <Ring value={share} size={64} />
          </div>
        </div>
        <div className="card">
          <div className="stat-label">
            <Timer size={14} /> {t("sessions.turns")}
          </div>
          <div className="stat-value">{num(turns.length)}</div>
          <div className="stat-hint">
            {usd(cost)} <span className="faint">/ {usd(baseline)}</span>
          </div>
        </div>
        <div className="card">
          <div className="stat-label">
            <Scissors size={14} /> {t("sessions.removed")}
          </div>
          <div className="stat-value">{compact(removed)}</div>
          <div className="stat-hint">
            {t("sessions.applied", { n: num(turns.filter((x) => x.schedule === "applied").length) })} ·{" "}
            {t("sessions.deferred", { n: num(turns.filter((x) => x.schedule === "deferred").length) })}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">
            <CircleAlert size={14} /> {t("sessions.leaks")}
          </div>
          <div className="stat-value" style={{ color: leaks > 0 ? "var(--rose)" : undefined }}>
            {num(leaks)}
          </div>
          <div className="stat-hint">{t("doctor.title")}</div>
        </div>
      </div>

      <div className="card mt">
        <div className="row between wrap" style={{ marginBottom: 4 }}>
          <h3 className="card-title" style={{ margin: 0 }}>
            {t("sessions.timeline")}
          </h3>
          <Legend
            items={[
              { label: t("sessions.cached"), color: "var(--mint)" },
              { label: t("sessions.uncached"), color: "var(--cyan)" },
            ]}
          />
        </div>
        <p className="small faint" style={{ margin: "0 0 14px" }}>
          {t("sessions.timelineHint")}
        </p>
        <Timeline turns={turns} />
      </div>

      <div className="card mt">
        <h3 className="card-title">{t("sessions.events")}</h3>
        <Events turns={turns} />
      </div>
    </div>
  );
}

function Timeline({ turns }: { turns: SessionTurn[] }) {
  const { t, num, usd } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...turns.map(promptOf));
  const shown = hover ?? turns.length - 1;
  const cur = turns[shown];
  const every = Math.max(1, Math.ceil(turns.length / 12));
  const scroller = useRef<HTMLDivElement>(null);
  // Long conversations scroll on small screens; start at the latest turn.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);

  return (
    <div>
      <div className="tl-scroll" ref={scroller}>
        <div className="tl">
          {turns.map((x, i) => {
            const p = promptOf(x);
            const uncached = x.inputTokens + x.cacheWriteTokens;
            return (
              <button
                type="button"
                // biome-ignore lint/suspicious/noArrayIndexKey: turns are an append-only list
                key={i}
                className={`tl-col ${i === shown ? "on" : ""}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onClick={() => setHover(i)}
                aria-label={`${t("sessions.turn")} ${x.turn ?? i + 1}`}
              >
                <span className="tl-marks">
                  {x.leak && <span className="tl-mark bad" />}
                  {x.schedule === "applied" && <span className="tl-mark violet" />}
                  {x.schedule === "deferred" && <span className="tl-mark warn" />}
                </span>
                <span className="tl-bar" style={{ height: `max(3px, calc((100% - 42px) * ${p / max}))` }}>
                  <span className="tl-uncached" style={{ flexGrow: x.cacheHit ? 0 : uncached }} />
                  <span className="tl-cached" style={{ flexGrow: x.cacheHit ? 1 : x.cacheReadTokens }} />
                </span>
                <span className="tl-x">{i % every === 0 ? (x.turn ?? i + 1) : ""}</span>
              </button>
            );
          })}
        </div>
      </div>
      {cur && (
        <div className="tl-readout small">
          <b>
            {t("sessions.turn")} {cur.turn ?? shown + 1}
          </b>
          <span>
            <i style={{ background: "var(--mint)" }} />
            {num(cur.cacheReadTokens)}
          </span>
          <span>
            <i style={{ background: "var(--cyan)" }} />
            {num(cur.inputTokens + cur.cacheWriteTokens)}
          </span>
          <span className="faint">→ {num(cur.outputTokens)}</span>
          <span>
            {usd(cur.cost)} <span className="faint">/ {usd(cur.baselineCost)}</span>
          </span>
          {cur.leak && <span className="badge bad">{t(`leak.${cur.leak.kind}`)}</span>}
          {cur.schedule === "applied" && <span className="badge violet">{t("sessions.eventApplied")}</span>}
          {cur.schedule === "deferred" && <span className="badge warn">{t("sessions.deferred", { n: 1 })}</span>}
        </div>
      )}
    </div>
  );
}

function Events({ turns }: { turns: SessionTurn[] }) {
  const { t, num, date } = useI18n();
  // Consecutive turns where the scheduler only deferred collapse into one row.
  const rows: { x: SessionTurn; n: number; until?: number; runs: number }[] = [];
  turns.forEach((x, i) => {
    const n = x.turn ?? i + 1;
    if (!x.leak && !x.schedule) return;
    const prev = rows[rows.length - 1];
    const deferredOnly = !x.leak && x.schedule === "deferred";
    if (deferredOnly && prev && !prev.x.leak && prev.x.schedule === "deferred" && (prev.until ?? prev.n) === n - 1) {
      prev.until = n;
      prev.runs++;
      return;
    }
    rows.push({ x, n, runs: 1 });
  });
  rows.reverse();
  if (rows.length === 0) return <p className="faint small">{t("doctor.none")}</p>;
  return (
    <div className="stack" style={{ gap: 0 }}>
      {rows.map(({ x, n, until, runs }) => (
        <div key={`${n}-${x.ts}`} className="event-row">
          <span className="mono faint" dir="ltr" style={{ minWidth: 64, textAlign: "start" }}>
            #{n}
            {until ? `–${until}` : ""}
          </span>
          <div className="grow stack" style={{ gap: 4 }}>
            {x.leak && (
              <div className="row wrap" style={{ gap: 8 }}>
                <span className="dot" style={{ color: "var(--rose)" }} />
                <span>{t("sessions.eventLeak", { kind: t(`leak.${x.leak.kind}`), location: x.leak.location })}</span>
                {x.leak.shape && <code className="mono small faint">{x.leak.shape}</code>}
                {x.leak.tokens ? (
                  <span className="small faint">
                    {t("doctor.wasted")}: {num(x.leak.tokens)}
                  </span>
                ) : null}
                {leakRepairable(x.leak) && <span className="badge ok">{t("doctor.repaired")}</span>}
              </div>
            )}
            {x.schedule === "applied" && (
              <div className="row wrap" style={{ gap: 8 }}>
                <span className="dot" style={{ color: "var(--violet)" }} />
                <span>{t("sessions.eventApplied")}</span>
                {x.optimizerSaved > 0 && (
                  <span className="small" dir="ltr" style={{ color: "var(--mint)" }}>
                    −{num(x.optimizerSaved)}
                  </span>
                )}
              </div>
            )}
            {x.schedule === "deferred" && (
              <div className="row wrap" style={{ gap: 8 }}>
                <span className="dot" style={{ color: "var(--amber)" }} />
                <span>{t("sessions.eventDeferred")}</span>
                {runs > 1 && <span className="badge warn">{t("sessions.deferred", { n: num(runs) })}</span>}
              </div>
            )}
          </div>
          <span className="small faint">
            <CalendarClock size={12} style={{ verticalAlign: -1 }} />{" "}
            {date(x.ts, { timeStyle: "medium", dateStyle: undefined })}
          </span>
        </div>
      ))}
    </div>
  );
}
