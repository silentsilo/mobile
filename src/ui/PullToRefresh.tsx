import { useRef, useState, type ReactNode, type TouchEvent } from "react";
import { RefreshCw } from "lucide-react";
import { t } from "../i18n";

/** How far to pull, after the drag's resistance, before letting go syncs. */
const TRIGGER = 64;
const MAX = 96;

/** True when something between the touch and the wrapper is scrolled down,
 * so the drag is a scroll back up and not a pull. */
function scrolledAway(from: EventTarget | null, wrapper: HTMLElement): boolean {
  for (let el = from as HTMLElement | null; el && el !== wrapper; el = el.parentElement) {
    if (el.scrollTop > 0) return true;
  }
  return false;
}

/**
 * Pull down from the top of a tab to sync, as in most phone apps. Wraps the
 * tab rather than each screen, so every tab gets it at once; the screen's
 * own scroll decides whether a drag is a pull.
 */
export function PullToRefresh({
  enabled,
  onRefresh,
  children,
}: {
  enabled: boolean;
  onRefresh: () => Promise<void>;
  children: ReactNode;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);

  const onTouchStart = (e: TouchEvent) => {
    const touch = e.touches[0];
    start.current =
      enabled && !busy && touch && wrapper.current && !scrolledAway(e.target, wrapper.current)
        ? { x: touch.clientX, y: touch.clientY }
        : null;
  };
  const onTouchMove = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (!start.current || !touch) return;
    const dy = touch.clientY - start.current.y;
    const dx = Math.abs(touch.clientX - start.current.x);
    // Sideways or upwards first: not a pull, for the rest of this touch.
    if (pull === 0 && (dy <= 0 || dx > dy)) {
      if (dy < 0 || dx > 8) start.current = null;
      return;
    }
    setPull(Math.min(Math.max(dy, 0) * 0.5, MAX));
  };
  const onTouchEnd = () => {
    const pulled = pull;
    start.current = null;
    setPull(0);
    if (pulled < TRIGGER) return;
    setBusy(true);
    void onRefresh().finally(() => setBusy(false));
  };

  const shown = busy ? TRIGGER : pull;
  return (
    <div
      ref={wrapper}
      className="pull-refresh"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {shown > 0 && (
        <div
          className="pull-refresh-dot"
          role={busy ? "status" : undefined}
          aria-label={busy ? t("silo.syncing") : undefined}
          style={{ transform: `translate(-50%, ${shown - 44}px)`, opacity: Math.min(shown / TRIGGER, 1) }}
        >
          <RefreshCw
            size={20}
            className={busy ? "spin" : undefined}
            style={busy ? undefined : { transform: `rotate(${pull * 4}deg)` }}
            color={pull >= TRIGGER || busy ? "var(--accent-text)" : "var(--text-muted)"}
          />
        </div>
      )}
      {children}
    </div>
  );
}
