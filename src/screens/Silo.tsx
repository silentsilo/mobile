import { ChevronRight, Cloud, Fingerprint, HardDrive, HeartPulse, History, Images, Languages, TextCursorInput, KeyRound, LockKeyhole, MonitorOff, RefreshCw, ScrollText, Smartphone, Trash2 } from "lucide-react";
import { LOCALES, dateLocale, languagePreference, setLanguage, systemLocale, t, useLocale } from "../i18n";
import { RecoveryCodeShow } from "../ui/RecoveryCodeShow";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type SyncStatus } from "../api";
import { formatAppError } from "../shared/errors";
import type { AuditStatus, RecoveryStatus } from "../shared/types";
import { HISTORY_POLICIES, type HistoryPolicy } from "../shared/entryHistory";
import { ChoiceRow, Notice, Sheet, ToggleRow, useToast } from "../ui/chrome";
import { applyTheme, readTheme, type ThemeChoice } from "../ui/theme";
import { SiloHeader } from "./Passwords";
import { announceSilo } from "./SiloSwitcher";
import { haptic } from "../ui/haptics";
import { useLeftOut } from "../ui/syncActivity";

function historyLabel(policy: HistoryPolicy): string {
  return policy === "fit" ? t("silo.history_fit") : t("silo.history_last", { count: policy });
}

const LOCK_CHOICES = [0, 30, 60, 300, 900, 1800, 3600];

function lockLabel(seconds: number): string {
  if (seconds === 0) return t("silo.lock_immediately");
  if (seconds < 60) return t("silo.lock_after_seconds", { count: seconds });
  if (seconds < 3600) return t("silo.lock_after_minutes", { count: seconds / 60 });
  return t("silo.lock_after_hours", { count: seconds / 3600 });
}

function shortLock(seconds: number) {
  if (seconds === 0) return t("silo.lock_short_now");
  if (seconds < 60) return t("silo.lock_short_seconds", { count: seconds });
  if (seconds < 3600) return t("silo.lock_short_minutes", { count: seconds / 60 });
  return t("silo.lock_short_hours", { count: seconds / 3600 });
}

/** A language's name, marked beta until a native speaker has read it. */
function languageLabel(l: (typeof LOCALES)[number]): string {
  return l.reviewed ? l.name : t("silo.language_beta", { name: l.name });
}

export function Silo({
  siloId,
  siloName,
  sync,
  onSynced,
  onKeys,
  onBackup,
  onTrash,
  onHealth,
  onStorage,
  onLocked,
}: {
  siloId: string;
  siloName: string;
  sync: SyncStatus | null;
  onSynced: () => void;
  onKeys: () => void;
  onBackup: () => void;
  onTrash: () => void;
  onHealth: () => void;
  onStorage: () => void;
  onLocked: () => void;
}) {
  const lang = useLocale();
  const [language, setLanguagePref] = useState(languagePreference);
  const [choosingLanguage, setChoosingLanguage] = useState(false);
  const [keyCount, setKeyCount] = useState<number | null>(null);
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(null);
  const [lockAfter, setLockAfter] = useState<number | null>(null);
  const [choosingLock, setChoosingLock] = useState(false);
  const [historyPolicy, setHistoryPolicy] = useState<HistoryPolicy | null>(null);
  const [choosingHistory, setChoosingHistory] = useState(false);
  const [aboutRecovery, setAboutRecovery] = useState(false);
  const [makingCode, setMakingCode] = useState(false);
  // A code on screen is already the silo's: the sheet stays until it is kept.
  const [codeShown, setCodeShown] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [backupOn, setBackupOn] = useState<boolean | null>(null);
  const [screenOff, setScreenOff] = useState<boolean | null>(null);
  const [removing, setRemoving] = useState(false);
  const leftOut = useLeftOut();
  const [autofill, setAutofill] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [aboutAutofill, setAboutAutofill] = useState(false);
  const [passkeys, setPasskeys] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [aboutPasskeys, setAboutPasskeys] = useState(false);
  const [audit, setAudit] = useState<AuditStatus | null>(null);
  const [aboutAudit, setAboutAudit] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.listKeys().then((k) => setKeyCount(k.length), () => setKeyCount(null));
    api.recoveryStatus().then(setRecovery, () => setRecovery(null));
    api.lockAfter().then(setLockAfter, () => setLockAfter(null));
    api.historyPolicy().then(setHistoryPolicy, () => setHistoryPolicy(null));
    api.lockOnScreenOff().then(setScreenOff, () => setScreenOff(null));
    api.auditStatus().then(setAudit, () => setAudit(null));
    const readAutofill = () => {
      api.autofillStatus().then(setAutofill, () => setAutofill(null));
      api.passkeysStatus().then(setPasskeys, () => setPasskeys(null));
    };
    void readAutofill();
    api.backupStatus().then((s) => setBackupOn(s.photos || s.videos || s.contacts), () => setBackupOn(null));
    // Coming back from Android's settings screen.
    const onVisible = () => document.visibilityState === "visible" && void readAutofill();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // A pass can start the log (on by default) or carry another device's
  // choice: the row follows each one.
  useEffect(() => {
    const stop = listen("sync-report", () => {
      api.auditStatus().then(setAudit, () => undefined);
    });
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, []);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const report = await api.syncNow();
      if (report.needs_rejoin) toast(t("silo.sync_left_out"));
      else if (report.key_material_replaced) toast(t("silo.sync_key_replaced"));
      else if (report.skipped) toast(t("silo.sync_already_running"));
      else if (report.blobs_failed > 0) toast(t("silo.sync_files_failed", { count: report.blobs_failed }));
      else toast(report.ops_pushed + report.ops_fetched > 0 ? t("silo.sync_done") : t("silo.sync_up_to_date"));
      api.auditStatus().then(setAudit, () => undefined);
      onSynced();
    } catch (e) {
      toast(formatAppError(e));
    } finally {
      setSyncing(false);
    }
  };

  const chooseLock = async (seconds: number) => {
    setChoosingLock(false);
    try {
      await api.setLockAfter(seconds);
      setLockAfter(seconds);
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const setAuditLog = async (enabled: boolean) => {
    try {
      setAudit(await api.setAuditLog(enabled));
      // The copies hear of it at the next sync. With none, there is nothing to send.
      void api.syncNow().catch(() => undefined);
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const chooseHistory = async (policy: HistoryPolicy) => {
    setChoosingHistory(false);
    try {
      await api.setHistoryPolicy(policy);
      setHistoryPolicy(policy);
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const lockNow = async () => {
    try {
      await api.lock();
      onLocked();
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const waiting = sync?.pending_ops ?? 0;
  const navRow = (Icon: typeof KeyRound, title: string, value: string, onClick: () => void, first = false) => (
    <button className={`row${first ? "" : " divide"}`} style={{ minHeight: 60 }} onClick={onClick}>
      <Icon size={20} color="var(--accent-text)" />
      <span style={{ flex: 1 }}>{title}</span>
      <span className="muted small">{value}</span>
      <ChevronRight size={18} color="var(--text-dim)" />
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <SiloHeader siloName={siloName} sync={sync} />
      <div className="screen-body tight" style={{ paddingTop: 0, gap: 18 }}>
        {audit?.enabled && (
          <button className="panel row" style={{ minHeight: 48, gap: 10 }} onClick={() => setAboutAudit(true)}>
            <ScrollText size={18} color="var(--accent-text)" />
            <span style={{ flex: 1 }}>
              {audit.organisation ? t("silo.audit_banner_org") : t("silo.audit_banner_on")}
            </span>
          </button>
        )}
        {sync?.configured && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="label" style={{ padding: "0 4px" }}>{t("silo.section_backup")}</span>
            <div className="panel" style={{ gap: 12, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Cloud size={20} color={waiting || leftOut ? "var(--warning)" : "var(--success)"} />
                <span style={{ flex: 1 }}>
                  {leftOut
                    ? t("silo.status_not_syncing")
                    : waiting
                      ? t("silo.status_waiting", { count: waiting })
                      : t("silo.status_synced")}
                </span>
              </div>
              <button className="btn secondary" aria-busy={syncing} onClick={syncNow} disabled={syncing}>
                {!syncing && <RefreshCw size={18} />}
                {syncing ? t("silo.syncing") : t("silo.sync_now")}
              </button>
            </div>
          </div>
        )}
        {sync?.configured && (
          <div className="panel">
            {navRow(Images, t("silo.row_phone_backup"), backupOn === null ? "" : backupOn ? t("silo.value_on") : t("silo.value_off"), onBackup, true)}
          </div>
        )}
        <div className="panel">
          {navRow(HardDrive, t("silo.row_storage"), sync?.configured ? "" : t("silo.value_storage_not_set"), onStorage, true)}
          {navRow(Trash2, t("silo.row_trash"), "", onTrash)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="label" style={{ padding: "0 4px" }}>{t("silo.section_security")}</span>
          <div className="panel">
            {navRow(HeartPulse, t("silo.row_health"), "", onHealth, true)}
            {autofill?.supported &&
              navRow(TextCursorInput, t("silo.row_autofill"), autofill.enabled ? t("silo.value_on") : t("silo.value_off"), () => setAboutAutofill(true))}
            {passkeys?.supported &&
              navRow(Fingerprint, t("silo.row_passkeys"), passkeys.enabled ? t("silo.value_on") : t("silo.value_off"), () => setAboutPasskeys(true))}
            {navRow(KeyRound, t("silo.row_keys"), keyCount === null ? "" : keyCount.toLocaleString(dateLocale()), onKeys)}
            {navRow(
              LockKeyhole,
              t("silo.row_recovery"),
              recovery?.enabled ? t("silo.value_active") : recovery ? t("silo.value_recovery_none") : "",
              () => setAboutRecovery(true),
            )}
            {navRow(
              ScrollText,
              t("silo.row_audit"),
              audit === null
                ? ""
                : audit.organisation
                  ? t("silo.value_organisation")
                  : audit.enabled
                    ? t("silo.value_on")
                    : t("silo.value_off"),
              () => setAboutAudit(true),
            )}
            {navRow(History, t("silo.row_history"), historyPolicy === null ? "" : historyLabel(historyPolicy), () => setChoosingHistory(true))}
            {navRow(Smartphone, t("silo.row_lock_background"), lockAfter === null ? "" : shortLock(lockAfter), () => setChoosingLock(true))}
            {screenOff !== null && (
              <ToggleRow
                icon={<MonitorOff size={20} color="var(--accent-text)" style={{ flex: "none" }} />}
                label={t("silo.row_screen_off")}
                checked={screenOff}
                onChange={() => {
                  const next = !screenOff;
                  setScreenOff(next);
                  api.setLockOnScreenOff(next).catch((e) => {
                    setScreenOff(!next);
                    toast(formatAppError(e));
                  });
                }}
              />
            )}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="label" style={{ padding: "0 4px" }}>{t("silo.section_appearance")}</span>
          <div className="segmented" role="group" aria-label={t("silo.theme")}>
            {(
              [
                ["system", t("silo.theme_system")],
                ["dark", t("silo.theme_dark")],
                ["light", t("silo.theme_light")],
              ] as const
            ).map(([choice, label]) => (
              <button
                key={choice}
                aria-pressed={theme === choice}
                onClick={() => {
                  applyTheme(choice);
                  setTheme(choice);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="panel">
            {navRow(
              Languages,
              t("silo.language"),
              language === "system" ? t("silo.theme_system") : (LOCALES.find((l) => l.id === lang)?.name ?? ""),
              () => setChoosingLanguage(true),
              true,
            )}
          </div>
        </div>
        <div className="spacer" />
        <button className="btn secondary" onClick={lockNow}>
          <LockKeyhole size={18} />
          {t("silo.lock_now")}
        </button>
        <button className="text-btn danger" style={{ alignSelf: "center" }} onClick={() => setRemoving(true)}>
          {t("silo.remove_silo")}
        </button>
        <p className="hint" style={{ alignSelf: "center", margin: 0 }}>
          SilentSilo {__APP_VERSION__}
        </p>
      </div>

      <Sheet open={choosingLanguage} onClose={() => setChoosingLanguage(false)} title={t("silo.language")}>
        <p className="hint">{t("silo.language_hint")}</p>
        <div className="panel" role="radiogroup" aria-label={t("silo.language")}>
          {[
            {
              id: "system",
              label: t("silo.language_system", { name: LOCALES.find((l) => l.id === systemLocale())?.name ?? "English" }),
            },
            ...LOCALES.map((l) => ({ id: l.id as string, label: languageLabel(l) })),
          ].map((choice, i) => (
            <ChoiceRow
              key={choice.id}
              first={i === 0}
              label={choice.label}
              checked={language === choice.id}
              onChoose={() => {
                setChoosingLanguage(false);
                setLanguagePref(choice.id);
                setLanguage(choice.id);
              }}
            />
          ))}
        </div>
      </Sheet>

      <Sheet open={choosingLock} onClose={() => setChoosingLock(false)} title={t("silo.row_lock_background")}>
        <p className="hint">{t("silo.lock_hint")}</p>
        <div className="panel" role="radiogroup" aria-label={t("silo.row_lock_background")}>
          {LOCK_CHOICES.map((seconds, i) => (
            <ChoiceRow
              key={seconds}
              first={i === 0}
              label={lockLabel(seconds)}
              checked={lockAfter === seconds}
              onChoose={() => void chooseLock(seconds)}
            />
          ))}
        </div>
      </Sheet>

      <Sheet open={aboutAudit} onClose={() => setAboutAudit(false)} title={t("silo.row_audit")}>
        {audit?.organisation ? (
          <p className="hint">{t("silo.audit_org_hint")}</p>
        ) : (
          <>
            <p className="hint">{t("silo.audit_hint")}</p>
            <div className="panel">
              <ToggleRow
                first
                label={t("silo.audit_toggle")}
                checked={audit?.enabled ?? false}
                disabled={audit === null}
                onChange={() => void setAuditLog(!(audit?.enabled ?? false))}
              />
            </div>
          </>
        )}
      </Sheet>

      <Sheet open={choosingHistory} onClose={() => setChoosingHistory(false)} title={t("silo.row_history")}>
        <p className="hint">{t("silo.history_hint")}</p>
        <div className="panel" role="radiogroup" aria-label={t("silo.row_history")}>
          {HISTORY_POLICIES.map((policy, i) => (
            <ChoiceRow
              key={String(policy)}
              first={i === 0}
              label={historyLabel(policy)}
              checked={historyPolicy === policy}
              onChoose={() => void chooseHistory(policy)}
            />
          ))}
        </div>
      </Sheet>

      <Sheet open={aboutAutofill} onClose={() => setAboutAutofill(false)} title={t("silo.row_autofill")}>
        <p className="hint">{autofill?.enabled ? t("silo.autofill_on_hint") : t("silo.autofill_off_hint")}</p>
        <button
          className="btn"
          onClick={() => {
            setAboutAutofill(false);
            api.enableAutofill().catch((e) => toast(formatAppError(e)));
          }}
        >
          {autofill?.enabled ? t("silo.android_change") : t("silo.android_turn_on")}
        </button>
      </Sheet>

      <Sheet open={aboutPasskeys} onClose={() => setAboutPasskeys(false)} title={t("silo.row_passkeys")}>
        <p className="hint">{passkeys?.enabled ? t("silo.passkeys_on_hint") : t("silo.passkeys_off_hint")}</p>
        <button
          className="btn"
          onClick={() => {
            setAboutPasskeys(false);
            api.enablePasskeys().catch((e) => toast(formatAppError(e)));
          }}
        >
          {passkeys?.enabled ? t("silo.android_change") : t("silo.android_turn_on")}
        </button>
      </Sheet>

      <Sheet open={removing} onClose={() => setRemoving(false)} title={t("silo.remove_title", { name: siloName })}>
        {!sync || sync.configured ? (
          <p className="hint">{t("silo.remove_hint")}</p>
        ) : (
          <Notice tone="error" quiet>
            {t("silo.remove_only_copy")}
          </Notice>
        )}
        {sync?.configured && waiting > 0 && (
          <Notice tone="warning">
            {leftOut
              ? t("silo.remove_lost_left_out", { count: waiting })
              : t("silo.remove_lost_waiting", { count: waiting })}
          </Notice>
        )}
        <button
          className="btn danger"
          onClick={async () => {
            setRemoving(false);
            try {
              // The silo this screen shows, not whichever is in front by now.
              haptic("heavy");
              await api.removeSilo(siloId);
              announceSilo("switched");
            } catch (e) {
              toast(formatAppError(e));
            }
          }}
        >
          {t("silo.remove_confirm")}
        </button>
        <button className="btn secondary" onClick={() => setRemoving(false)}>
          {t("common.cancel")}
        </button>
      </Sheet>

      <Sheet open={aboutRecovery} onClose={() => { if (codeShown) return; setAboutRecovery(false); setMakingCode(false); }} title={t("silo.row_recovery")}>
        <p className="hint">{recovery?.enabled ? t("silo.recovery_on_hint") : t("silo.recovery_off_hint")}</p>
        {makingCode ? (
          <RecoveryCodeShow
            replacing={!!recovery?.enabled}
            archiveTargets={sync?.archive_targets ?? 0}
            onShown={() => setCodeShown(true)}
            onDone={() => {
              setCodeShown(false);
              setMakingCode(false);
              setAboutRecovery(false);
              api.recoveryStatus().then(setRecovery, () => setRecovery(null));
            }}
          />
        ) : (
          <>
            <button className={recovery?.enabled ? "btn secondary" : "btn"} onClick={() => setMakingCode(true)}>
              {recovery?.enabled ? t("silo.recovery_replace") : t("silo.recovery_make")}
            </button>
            <button className="btn secondary" onClick={() => setAboutRecovery(false)}>
              {t("common.close")}
            </button>
          </>
        )}
      </Sheet>
    </div>
  );
}
