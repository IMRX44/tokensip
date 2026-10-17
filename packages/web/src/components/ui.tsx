import { AlertTriangle, Check, CheckCircle2, Copy, Info, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { brandColor, initials } from "../lib/brand";

export function Switch({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange(v: T): void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? "active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Modal({
  title,
  subtitle,
  children,
  footer,
  onClose,
  wide,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose(): void;
  wide?: boolean;
}) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close; Escape is handled above
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="btn ghost sm icon-btn" onClick={onClose} aria-label="close">
            <X size={16} />
          </button>
        </div>
        {subtitle && (
          <p className="muted" style={{ margin: "0 0 16px" }}>
            {subtitle}
          </p>
        )}
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "ok" | "warn" | "bad";
  title?: string;
  children: ReactNode;
}) {
  const Icon = tone === "info" ? Info : tone === "ok" ? CheckCircle2 : AlertTriangle;
  const color = { info: "var(--cyan)", ok: "var(--mint)", warn: "var(--amber)", bad: "var(--rose)" }[tone];
  return (
    <div className={`callout ${tone}`}>
      <Icon size={16} color={color} />
      <div>
        {title && <div style={{ fontWeight: 650, marginBottom: 2 }}>{title}</div>}
        <div className="muted">{children}</div>
      </div>
    </div>
  );
}

export function SafetyBadge({ safety }: { safety: "lossless" | "equivalent" | "lossy" }) {
  const { t } = useI18n();
  const tone = safety === "lossless" ? "ok" : safety === "equivalent" ? "info" : "bad";
  return <span className={`badge ${tone}`}>{t(`safety.${safety}`)}</span>;
}

export function Avatar({ id, name, size }: { id: string; name: string; size?: number }) {
  return (
    <span className="avatar" style={{ background: brandColor(id), width: size, height: size }}>
      {initials(name)}
    </span>
  );
}

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }, []);
  return [copied, copy];
}

export function CopyButton({ text, label }: { text: string; label?: boolean }) {
  const { t } = useI18n();
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      className={`btn sm ${label ? "" : "icon-btn ghost"}`}
      onClick={() => copy(text)}
      aria-label={t("common.copy")}
    >
      {copied ? <Check size={14} color="var(--mint)" /> : <Copy size={14} />}
      {label && (copied ? t("common.copied") : t("common.copy"))}
    </button>
  );
}

function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /(#[^\n]*|\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)|\b(import|from|const|await|new|export|def|return|async|curl|client|as)\b/g;
  let last = 0;
  let i = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const cls = m[1] ? "tok-c" : m[2] ? "tok-s" : "tok-k";
    out.push(
      <span key={i++} className={cls}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  out.push(code.slice(last));
  return out;
}

export function CodeBlock({ code, title }: { code: string; title?: string }) {
  return (
    <div className="code">
      {title ? (
        <div className="code-head">
          <span>{title}</span>
          <CopyButton text={code} />
        </div>
      ) : (
        <span className="copy">
          <CopyButton text={code} />
        </span>
      )}
      <pre>{highlight(code)}</pre>
    </div>
  );
}

export function Empty({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <div style={{ fontWeight: 650, fontSize: 16 }}>{title}</div>
      {body && (
        <p className="muted" style={{ maxWidth: 440, margin: "6px auto 16px" }}>
          {body}
        </p>
      )}
      {action}
    </div>
  );
}

export function Skeleton({ h = 18, w = "100%" }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} />;
}

// ------------------------------------------------------------------ toasts

interface Toast {
  id: number;
  text: string;
  tone: "ok" | "bad";
}
const ToastCtx = createContext<(text: string, tone?: "ok" | "bad") => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: "ok" | "bad" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
