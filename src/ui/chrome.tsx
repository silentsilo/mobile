import { ArrowLeft, Check, CircleAlert, Info, Plus, TriangleAlert } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBackLayer } from "./back";
import { isIOS } from "./platform";
import { haptic } from "./haptics";

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

/** Where a setup flow is: making a silo has four steps, joining one three. */
export function StepBar({ step, of, onBack }: { step: number; of: number; onBack: () => void }) {
  useBackLayer(true, onBack);
  return (
    <div className="top-bar">
      <button className="icon-btn" aria-label="Back" style={{ color: "var(--ink)" }} onClick={onBack}>
        <ArrowLeft size={22} />
      </button>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, paddingRight: 52 }}>
        <div className="muted caption" style={{ fontWeight: 600, textAlign: "center" }}>
          Step {step} of {of}
        </div>
        <div className="step-track" aria-hidden>
          {Array.from({ length: of }, (_, i) => i + 1).map((i) => (
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
      onClick={() => {
        haptic("tick");
        onChange();
      }}
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

// Sheets open now; the page under them is inert while any is.
let openSheets = 0;

/**
 * A bottom sheet (a centred dialog on a tablet). Back and the scrim close it,
 * focus moves into it, and the page under it cannot be reached until it
 * closes. No grabber: it does not follow a drag.
 */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  useBackLayer(open, onClose);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Still on screen while it slides away; gone once the slide ends.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const closing = mounted && !open;
  // What it showed while open: the state behind it is usually cleared at
  // once, and the sheet should not empty itself on the way out.
  const shown = useRef({ title, children });
  if (open) shown.current = { title, children };

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById("root");
    openSheets += 1;
    root?.setAttribute("inert", "");
    // A field that asked for focus keeps it; otherwise the title takes it.
    const sheet = ref.current;
    if (sheet && !sheet.contains(document.activeElement)) {
      (sheet.querySelector<HTMLElement>(".sheet-title") ?? sheet).focus({ preventScroll: true });
    }
    return () => {
      openSheets -= 1;
      if (openSheets === 0) root?.removeAttribute("inert");
      // Back where it was, unless something else (another sheet's field) has it now.
      const active = document.activeElement;
      const lost = !active || active === document.body || !!sheet?.contains(active);
      if (lost && before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [open]);

  // The slide's end unmounts it; the timer covers a slide that never runs.
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setMounted(false), 400);
    return () => window.clearTimeout(timer);
  }, [closing]);

  if (!mounted) return null;
  const { title: heading, children: body } = open ? { title, children } : shown.current;
  return createPortal(
    <>
      <div className={closing ? "scrim closing" : "scrim"} onClick={closing ? undefined : onClose} />
      <div
        ref={ref}
        className={closing ? "sheet closing" : "sheet"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading ? titleId : undefined}
        tabIndex={-1}
        inert={closing || undefined}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) setMounted(false);
        }}
      >
        {heading && (
          <h2 className="sheet-title" id={titleId} tabIndex={-1}>
            {heading}
          </h2>
        )}
        {body}
      </div>
    </>,
    document.body,
  );
}

/**
 * One option in a list where exactly one is chosen: a radio on Android, a
 * check mark on iOS. Wrap the rows in a `role="radiogroup"` panel.
 */
export function ChoiceRow({
  label,
  checked,
  onChoose,
  first = false,
  extra,
}: {
  label: string;
  checked: boolean;
  onChoose: () => void;
  first?: boolean;
  extra?: ReactNode;
}) {
  return (
    <button
      className={`row choice-row${first ? "" : " divide"}`}
      role="radio"
      aria-checked={checked}
      onClick={() => {
        haptic("tick");
        onChoose();
      }}
    >
      {!isIOS && <span className="radio" aria-hidden />}
      <span className="row-title" style={{ flex: 1, fontWeight: checked ? 650 : 500 }}>
        {label}
      </span>
      {extra}
      {isIOS && <Check size={20} className="choice-check" aria-hidden />}
    </button>
  );
}

type ToastApi = (message: string) => void;
const ToastContext = createContext<ToastApi>(() => undefined);

/** Long enough to read: 4 s for a word, up to 10 s for a paragraph. */
export function toastDuration(text: string): number {
  return Math.min(10_000, Math.max(4_000, 1_500 + text.length * 60));
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback<ToastApi>((text) => {
    setMessage(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(null), toastDuration(text));
  }, []);
  const dismiss = () => {
    window.clearTimeout(timer.current);
    setMessage(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* Always there, so a screen reader hears each message; outside the
          app's root, which is inert while a sheet is open. */}
      {createPortal(
        <div className="toast-region" role="status" aria-live="polite">
          {message && (
            <button className="toast" onClick={dismiss} aria-describedby="toast-dismiss">
              {message}
              <span id="toast-dismiss" className="visually-hidden">
                Tap to dismiss.
              </span>
            </button>
          )}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/**
 * Placeholder rows while a list loads. Nothing for the first 300 ms, so a
 * quick answer does not flash.
 */
export function Skeleton({ rows = 6, avatar = true }: { rows?: number; avatar?: boolean }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), 300);
    return () => window.clearTimeout(timer);
  }, []);
  if (!shown) return null;
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" aria-hidden>
          {avatar && <span className="skeleton-block" style={{ width: 40, height: 40 }} />}
          <span className="skeleton-lines">
            <span className="skeleton-block" style={{ width: `${55 + ((i * 17) % 30)}%` }} />
            <span className="skeleton-block" style={{ width: `${30 + ((i * 11) % 25)}%`, height: 10 }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** An empty list: what it is, why, and the one thing to do about it. */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden>
        {icon}
      </span>
      <h2 className="empty-title">{title}</h2>
      {hint && <p className="hint">{hint}</p>}
      {action && (
        <button className="btn secondary inline" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/** The screen's one "add": a floating button on Android, a "+" in the bar on iOS. */
export function AddButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button className={isIOS ? "icon-btn accent" : "fab"} aria-label={label} onClick={onClick} disabled={disabled}>
      <Plus size={24} />
    </button>
  );
}
