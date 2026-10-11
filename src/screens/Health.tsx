import { ChevronDown, ChevronRight, Globe, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { analyseHealth, type HealthFinding, type SiloHealth } from "../shared/health";
import { subtitleFor } from "../shared/passwordUtil";
import type { PasswordEntry } from "../shared/types";
import { canIgnore, fingerprint, loadIgnored, saveIgnored, splitIgnored } from "../shared/healthIgnored";
import { checkPasswords, type PwnedReport } from "../shared/pwned";
import { EmptyState, Notice, Skeleton, TopBar } from "../ui/chrome";
import { dateLocale, t, useLocale } from "../i18n";

const COLOUR: Record<HealthFinding["severity"], string> = {
  high: "var(--danger)",
  medium: "var(--warning)",
  info: "var(--text-dim)",
};

/** What is wrong with the silo's passwords and setup, worked out on this
 * phone from what is already open. Nothing is sent anywhere. */
export function Health({ siloId, onBack, onOpen }: { siloId: string; onBack: () => void; onOpen: (entry: PasswordEntry) => void }) {
  const locale = useLocale();
  // What the findings are worked out from; they are worded at render time,
  // so a language change rewrites them.
  const [inputs, setInputs] = useState<{ entries: PasswordEntry[]; silo: SiloHealth } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.readPasswords(), api.syncStatus(), api.listKeys(), api.recoveryStatus()])
      .then(([entries, sync, keys, recovery]) =>
        setInputs({
          entries,
          silo: {
            backupConfigured: sync.configured,
            // The phone keeps no record of a failed pass yet, and has no
            // backup test, so neither finding applies here.
            backupFailing: false,
            backupError: null,
            securityKeyCount: keys.length,
            recoveryCodeSet: recovery.enabled,
            // A phone's free space is not the silo's problem worth a finding.
            freeBytes: null,
            headroomBytes: 0,
          },
        }),
      )
      .catch((e) => setError(formatAppError(e)));
  }, []);

  const all = useMemo(
    () => (inputs ? analyseHealth(inputs.entries, inputs.silo) : null),
    [inputs, locale],
  );
  // Set aside on this phone, as desktop does on the computer: what is not
  // critical, until it grows.
  const [ignored, setIgnored] = useState(() => loadIgnored(siloId));
  const [showIgnored, setShowIgnored] = useState(false);
  const split = useMemo(() => (all ? splitIgnored(all, ignored) : null), [all, ignored]);
  const findings = split ? (showIgnored ? [...split.active, ...split.ignored] : split.active) : null;
  const toggleIgnored = (finding: HealthFinding) => {
    const next = new Set(ignored);
    const key = fingerprint(finding);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    saveIgnored(siloId, next);
    setIgnored(next);
  };

  // Only a hash prefix leaves the phone; the rest is compared here.
  const [breaches, setBreaches] = useState<
    { kind: "idle" } | { kind: "busy"; done: number; total: number } | { kind: "done"; report: PwnedReport } | { kind: "unavailable" }
  >({ kind: "idle" });
  const runBreachCheck = async () => {
    if (!inputs) return;
    setBreaches({ kind: "busy", done: 0, total: 0 });
    try {
      const report = await checkPasswords(inputs.entries, (prefix) => api.pwnedRange(prefix), (done, total) =>
        setBreaches({ kind: "busy", done, total }),
      );
      setBreaches(report.checked > 0 && report.unavailable === report.checked ? { kind: "unavailable" } : { kind: "done", report });
    } catch {
      setBreaches({ kind: "unavailable" });
    }
  };
  const nameOf = (id: string) => inputs?.entries.find((e) => e.id === id);

  return (
    <div className="screen">
      <TopBar onBack={onBack} backLabel={t("pw.back_silo")} />
      <div className="screen-body tight" style={{ gap: 14 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
          <h1 className="title">{t("pw.health_title")}</h1>
          <p className="hint">{t("pw.health_local")}</p>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {!findings && !error && <Skeleton avatar={false} rows={4} />}
        {findings?.length === 0 && (
          <EmptyState icon={<ShieldCheck size={26} />} title={t("pw.health_nothing")} hint={t("pw.health_all_good")} />
        )}
        {findings?.map((finding) => {
          const expanded = open === finding.id;
          const isIgnored = ignored.has(fingerprint(finding)) && canIgnore(finding);
          return (
            <div key={finding.id} className="panel">
              <button className="row" style={{ minHeight: 64, alignItems: "flex-start", paddingTop: 14 }} onClick={() => setOpen(expanded ? null : finding.id)}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: COLOUR[finding.severity], marginTop: 6, flex: "none" }} />
                <span className="row-text">
                  <span className="row-title">{finding.title}</span>
                  <span className="row-sub" style={{ whiteSpace: "normal" }}>{finding.detail}</span>
                </span>
                {finding.entries.length > 0 && (expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} color="var(--text-dim)" />)}
              </button>
              {expanded && canIgnore(finding) && (
                <div className="row divide" style={{ justifyContent: "flex-end" }}>
                  <button className="text-btn" onClick={() => toggleIgnored(finding)}>
                    {isIgnored ? t("dlg.health_show_again") : t("dlg.health_ignore")}
                  </button>
                </div>
              )}
              {expanded &&
                (finding.groups ?? [finding.entries]).map((group, g) => (
                  <div key={g} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                    {group.map((entry) => (
                      <button key={entry.id} className="row divide" style={{ paddingLeft: 40 }} onClick={() => onOpen(entry)}>
                        <span className="row-text">
                          <span className="row-title">{entry.service}</span>
                          <span className="row-sub">{subtitleFor(entry)}</span>
                        </span>
                        <ChevronRight size={18} color="var(--text-dim)" />
                      </button>
                    ))}
                  </div>
                ))}
            </div>
          );
        })}
        {split && split.ignored.length > 0 && (
          <button className="text-btn" style={{ alignSelf: "flex-start" }} onClick={() => setShowIgnored(!showIgnored)}>
            {t("dlg.health_ignored", { count: split.ignored.length })}
          </button>
        )}
        {inputs && inputs.entries.length > 0 && (
          <div className="panel" style={{ padding: 16, gap: 10, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Globe size={20} aria-hidden />
              <span style={{ flex: 1, fontWeight: 650 }}>{t("dlg.health_breach_title")}</span>
            </div>
            <p className="hint small">{t("dlg.health_breach_hint")}</p>
            <button className="btn secondary" disabled={breaches.kind === "busy"} aria-busy={breaches.kind === "busy"} onClick={() => void runBreachCheck()}>
              {breaches.kind === "busy"
                ? breaches.total
                  ? t("dlg.health_checking_count", { done: breaches.done, total: breaches.total })
                  : t("dlg.health_checking")
                : t("dlg.health_check_now")}
            </button>
            {breaches.kind === "unavailable" && <p className="hint small">{t("dlg.health_breach_unavailable")}</p>}
            {breaches.kind === "done" &&
              (breaches.report.exposures.length === 0 ? (
                <p className="hint small">
                  {t("dlg.health_breach_none", { count: breaches.report.checked })}
                  {breaches.report.unavailable > 0 && ` ${t("dlg.health_breach_partial", { count: breaches.report.unavailable })}`}
                </p>
              ) : (
                <>
                  <p className="small" style={{ fontWeight: 600 }}>{t("dlg.health_breach_found", { count: breaches.report.exposures.length })}</p>
                  {breaches.report.exposures.flatMap((exposure) =>
                    exposure.entryIds.map((id) => {
                      const entry = nameOf(id);
                      return (
                        <button key={id} className="row divide" onClick={() => entry && onOpen(entry)}>
                          <span className="row-text">
                            <span className="row-title">{entry?.service || t("dlg.untitled")}</span>
                            <span className="row-sub">
                              {t("dlg.health_seen", { count: exposure.count, times: exposure.count.toLocaleString(dateLocale()) })}
                            </span>
                          </span>
                          <ChevronRight size={18} color="var(--text-dim)" />
                        </button>
                      );
                    }),
                  )}
                </>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
