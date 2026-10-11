import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { byDay, describe } from "../shared/activityEvents";
import { formatAppError } from "../shared/errors";
import type { AuditEntry } from "../shared/types";
import { Notice, Skeleton, TopBar } from "../ui/chrome";
import { dateLocale, t, useLocale } from "../i18n";

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

  const days = useMemo(() => byDay(entries ?? []), [entries]);
  const time = (ms: number) => new Date(ms).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="screen">
      <TopBar onBack={onBack} backLabel={t("silo.tab_name")} title={t("silo.row_audit")} />
      <div className="screen-body tight" style={{ gap: 16 }}>
        {error && <Notice tone="error">{error}</Notice>}
        {unread.length > 0 && <Notice tone="warning">{t("silo.activity_copies_unread", { names: unread.join(", ") })}</Notice>}
        {!entries && !error && <Skeleton avatar={false} rows={6} />}
        {entries && entries.length === 0 && <p className="hint">{t("silo.activity_empty")}</p>}
        {days.map((day) => (
          <div key={day.label} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="label" style={{ padding: "0 4px" }}>
              {day.label}
            </span>
            <div className="panel">
              {day.events.map((e, i) => {
                const d = describe(e);
                const device = names[e.device];
                return (
                  <div key={`${e.device}:${e.i}`} className={`row${i > 0 ? " divide" : ""}`} style={{ alignItems: "flex-start", paddingTop: 12, paddingBottom: 12 }}>
                    <span className="row-text" style={{ gap: 3 }}>
                      <span style={{ whiteSpace: "normal" }}>
                        {d.before}
                        {d.object && <strong>{d.object}</strong>}
                        {d.after}
                      </span>
                      {d.details.length > 0 && <span className="row-sub" style={{ whiteSpace: "normal" }}>{d.details.join(" · ")}</span>}
                      <span className="row-sub">
                        {[time(e.t), device, d.via].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
