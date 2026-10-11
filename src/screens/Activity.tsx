import { useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  CirclePlus,
  Copy,
  Dot,
  Eye,
  ExternalLink,
  FileDown,
  FilePlus,
  FileText,
  FileUp,
  Globe,
  History,
  KeyRound,
  Laptop,
  LifeBuoy,
  Lock,
  LockOpen,
  Pencil,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  SquareTerminal,
  Timer,
  Trash,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { api } from "../api";
import { byDay, describe, KIND_CODES, KIND_LABELS, type ActivityIcon, type ActivityKind } from "../shared/activityEvents";
import { formatAppError } from "../shared/errors";
import type { AuditEntry } from "../shared/types";
import { EmptyState, Notice, Skeleton, TopBar } from "../ui/chrome";
import { dateLocale, t, useLocale } from "../i18n";

/** Desktop's pictures for the same events. */
const ICONS: Record<ActivityIcon, LucideIcon> = {
  unlock: LockOpen,
  lock: Lock,
  refused: ShieldAlert,
  show: Eye,
  copy: Copy,
  code: Timer,
  browser: Globe,
  app: AppWindow,
  ssh: SquareTerminal,
  create: CirclePlus,
  edit: Pencil,
  delete: Trash2,
  restore: History,
  import: FileDown,
  export: FileUp,
  file: FileText,
  "file-out": ExternalLink,
  "file-add": FilePlus,
  trash: Trash,
  key: KeyRound,
  recovery: LifeBuoy,
  rotate: RefreshCw,
  log: ScrollText,
  device: Laptop,
  repair: Wrench,
  other: Dot,
};

const KINDS = Object.keys(KIND_LABELS) as ActivityKind[];

/**
 * The silo's activity log, newest first, grouped by day: what happened, to
 * what, on which device. The sentences are desktop's; the search and the
 * export stay on the computer.
 */
export function Activity({ onBack }: { onBack: () => void }) {
  useLocale();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [unread, setUnread] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<ActivityKind | null>(null);

  useEffect(() => {
    api.readActivity().then(
      (page) => {
        setEntries(page.entries);
        setNames(page.names);
        setUnread(page.copies_unread);
      },
      (e) => setError(formatAppError(e)),
    );
  }, []);

  const counts = useMemo(() => {
    const found = new Map<ActivityKind, number>();
    for (const e of entries ?? []) {
      const k = KINDS.find((k) => KIND_CODES[k].includes(e.c));
      if (k) found.set(k, (found.get(k) ?? 0) + 1);
    }
    return found;
  }, [entries]);
  const shown = useMemo(
    () => (entries ?? []).filter((e) => kind === null || KIND_CODES[kind].includes(e.c)),
    [entries, kind],
  );
  const days = useMemo(() => byDay(shown), [shown]);
  const time = (ms: number) => new Date(ms).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="screen">
      <TopBar onBack={onBack} backLabel={t("silo.tab_name")} title={t("silo.row_audit")} />
      {entries && entries.length > 0 && (
        <div className="chips" role="tablist" aria-label={t("silo.row_audit")}>
          <button className="chip" role="tab" aria-selected={kind === null} onClick={() => setKind(null)}>
            {t("silo.activity_all")}
            <span className="chip-count">{entries.length}</span>
          </button>
          {KINDS.filter((k) => counts.has(k)).map((k) => (
            <button key={k} className="chip" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
              {KIND_LABELS[k]}
              <span className="chip-count">{counts.get(k)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="screen-body tight" style={{ gap: 0, paddingTop: 0 }}>
        {error && <Notice tone="error">{error}</Notice>}
        {unread.length > 0 && <Notice tone="warning">{t("silo.activity_copies_unread", { names: unread.join(", ") })}</Notice>}
        {!entries && !error && <Skeleton rows={6} />}
        {entries && entries.length === 0 && <EmptyState icon={<ScrollText size={26} />} title={t("silo.activity_empty")} />}
        {days.map((day) => (
          <section key={day.label} className="activity-day">
            <h2 className="activity-day-label">{day.label}</h2>
            <ol className="activity-list">
              {day.events.map((e) => {
                const d = describe(e);
                const Icon = ICONS[d.icon];
                const meta = [time(e.t), names[e.device], d.via].filter(Boolean).join(" · ");
                return (
                  <li key={`${e.device}:${e.i}`} className={`activity-event${d.tone === "notice" ? " is-notice" : ""}`}>
                    <span className="activity-icon" aria-hidden>
                      <Icon size={17} />
                    </span>
                    <span className="activity-text">
                      <span className="activity-sentence">
                        {d.before}
                        {d.object && <strong>{d.object}</strong>}
                        {d.after}
                      </span>
                      {d.details.length > 0 && <span className="activity-details">{d.details.join(" · ")}</span>}
                      <span className="activity-meta">{meta}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
