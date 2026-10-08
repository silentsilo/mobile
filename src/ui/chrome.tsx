import { ArrowLeft, CircleAlert, Info, TriangleAlert } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useBackLayer } from "./back";

const nothing = () => undefined;

export function TopBar({
  onBack,
  backLabel,
  title,
  right,
}: {
  onBack?: () => void;
  backLabel?: string;
  title?: string;
  right?: ReactNode;
}) {
  useBackLayer(!!onBack, onBack ?? nothing);
  return (
    <div className="top-bar">
      {onBack &&
        (backLabel ? (
          <button className="text-btn back-label" onClick={onBack}>
            <ArrowLeft size={22} style={{ flex: "none" }} />
            <span>{backLabel}</span>
          </button>
        ) : (
          <button className="icon-btn" aria-label="Back" style={{ color: "var(--ink)" }} onClick={onBack}>
            <ArrowLeft size={22} />
          </button>
        ))}
      <div className="top-bar-title">{title}</div>
      {right}
    </div>
  );
}

export function StepBar({ step, onBack }: { step: 1 | 2 | 3; onBack: () => void }) {
  useBackLayer(true, onBack);
  return (
    <div className="top-bar">
      <button className="icon-btn" aria-label="Back" style={{ color: "var(--ink)" }} onClick={onBack}>
        <ArrowLeft size={22} />
      </button>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, paddingRight: 52 }}>
        <div className="muted caption" style={{ fontWeight: 600, textAlign: "center" }}>
          Step {step} of 3
        </div>
        <div className="step-track" aria-hidden>
          {[1, 2, 3].map((i) => (
            <span key={i} className={i <= step ? "done" : undefined} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function Field({ label, error, errorId, children }: { label: string; error?: string | null; errorId?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field">
        <span className="label">{label}</span>
        {children}
      </label>
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}

/** The reason a field is not accepted, under it, announced when it appears. */
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p className="field-error" id={id} role="alert">
      <CircleAlert size={16} aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/**
 * A boxed message. Errors are announced when they appear; `quiet` is for one
 * that is part of the screen from the start.
 */
export function Notice({
  tone,
  quiet = false,
  style,
  children,
}: {
  tone?: "error" | "warning";
  quiet?: boolean;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const Icon = tone === "error" ? CircleAlert : tone === "warning" ? TriangleAlert : Info;
  return (
    <div className={`notice${tone ? ` ${tone}` : ""}`} role={tone === "error" && !quiet ? "alert" : undefined} style={style}>
      <Icon size={18} aria-hidden />
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

/** A row that is a switch as a whole: the label, the hint and the track. */
export function ToggleRow({
  label,
  hint,
  icon,
  checked,
  onChange,
  disabled,
  busy,
  first = false,
}: {
  label: string;
  hint?: string;
  icon?: ReactNode;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  busy?: boolean;
  first?: boolean;
}) {
  return (
    <button
      className={`row toggle-row${first ? "" : " divide"}`}
      role="switch"
      aria-checked={checked}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={onChange}
    >
      {icon}
      <span className="row-text">
        <span className="row-title" style={{ fontWeight: 500, whiteSpace: "normal" }}>
          {label}
        </span>
        {hint && <span className="row-sub">{hint}</span>}
      </span>
      <span className="switch" aria-hidden />
    </button>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  useBackLayer(open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grabber" />
        {title && <div style={{ fontWeight: 700, fontSize: "var(--fs-heading)" }}>{title}</div>}
        {children}
      </div>
    </>
  );
}

type ToastApi = (message: string) => void;
const ToastContext = createContext<ToastApi>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback<ToastApi>((text) => {
    setMessage(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(null), 2800);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {message && (
        <div className="toast" role="status">
          {message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
