import { ArrowLeft } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

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
  return (
    <div className="top-bar">
      {onBack &&
        (backLabel ? (
          <button className="text-btn" style={{ paddingLeft: 4, gap: 2 }} onClick={onBack}>
            <ArrowLeft size={22} />
            {backLabel}
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
  return (
    <div className="top-bar">
      <button className="icon-btn" aria-label="Back" style={{ color: "var(--ink)" }} onClick={onBack}>
        <ArrowLeft size={22} />
      </button>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, paddingRight: 52 }}>
        <div className="muted" style={{ fontSize: "0.82rem", fontWeight: 600, textAlign: "center" }}>
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

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grabber" />
        {title && <div style={{ fontWeight: 700, fontSize: "1.15rem" }}>{title}</div>}
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
