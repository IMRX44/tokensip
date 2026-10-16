import { useState } from "react";
import { useI18n } from "../i18n";
import type { Catalog, ProfileId } from "../lib/api";
import { Callout, Modal } from "./ui";

const LEVEL: Record<ProfileId, number> = { off: 0, safe: 1, balanced: 2, aggressive: 3, extreme: 4 };

export function ProfilePicker({
  catalog,
  value,
  onChange,
  compact,
}: {
  catalog: Catalog;
  value: ProfileId;
  onChange(p: ProfileId): void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState<ProfileId | null>(null);
  const info = (id: ProfileId) => catalog.profiles.find((p) => p.id === id);

  const choose = (id: ProfileId) => {
    const risk = info(id)?.risk;
    if ((risk === "medium" || risk === "high") && id !== value) setPending(id);
    else onChange(id);
  };

  const current = info(value);
  return (
    <>
      <div className="profiles">
        {catalog.profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`profile risk-${p.risk} ${p.id === value ? "active" : ""}`}
            onClick={() => choose(p.id)}
            aria-pressed={p.id === value}
          >
            <div className="row between">
              <span className="profile-name">{t(`profile.${p.id}`)}</span>
              <span
                className={`badge ${p.risk === "none" ? "ok" : p.risk === "low" ? "info" : p.risk === "medium" ? "warn" : "bad"}`}
              >
                {t(`risk.${p.risk}`)}
              </span>
            </div>
            <div className={`meter ${p.risk === "medium" ? "medium" : p.risk === "high" ? "high" : ""}`}>
              {[1, 2, 3, 4].map((i) => (
                <span key={i} className={i <= LEVEL[p.id] ? "on" : ""} />
              ))}
            </div>
            {!compact && (
              <span className="small faint">
                {t("profile.ratio")}: <b className="muted">{p.typicalPromptRatio}</b>
              </span>
            )}
          </button>
        ))}
      </div>
      {!compact && (
        <p className="muted small" style={{ margin: "12px 2px 0" }}>
          {t(`profile.${value}.desc`)}
        </p>
      )}
      {!compact && current?.warning && (
        <div className="mt">
          <Callout tone={current.risk === "high" ? "bad" : "warn"} title={t("profile.warnTitle")}>
            {t(`profile.${value}.desc`)}
          </Callout>
        </div>
      )}
      {pending && (
        <Modal
          title={t("profile.warnTitle")}
          onClose={() => setPending(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setPending(null)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  onChange(pending);
                  setPending(null);
                }}
              >
                {t("profile.confirm", { profile: t(`profile.${pending}`) })}
              </button>
            </>
          }
        >
          <Callout tone={info(pending)?.risk === "high" ? "bad" : "warn"} title={t(`profile.${pending}`)}>
            {t(`profile.${pending}.desc`)}
          </Callout>
          <p className="small faint" style={{ marginBottom: 0 }}>
            {info(pending)?.warning}
          </p>
        </Modal>
      )}
    </>
  );
}
