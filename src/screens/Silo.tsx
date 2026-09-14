import { ChevronRight, Cloud, Images, KeyRound, LockKeyhole, RefreshCw, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type SyncStatus } from "../api";
import { formatAppError } from "../shared/errors";
import type { RecoveryStatus } from "../shared/types";
import { Sheet, useToast } from "../ui/chrome";
import { applyTheme, readTheme, type ThemeChoice } from "../ui/theme";
import { SiloHeader } from "./Passwords";

const LOCK_CHOICES = [
  { seconds: 0, label: "Immediately" },
  { seconds: 30, label: "After 30 seconds" },
  { seconds: 60, label: "After 1 minute" },
  { seconds: 300, label: "After 5 minutes" },
];

function shortLock(seconds: number) {
  return seconds === 0 ? "Now" : seconds < 60 ? `${seconds} s` : `${seconds / 60} min`;
}

export function Silo({
  siloName,
  sync,
  onSynced,
  onKeys,
  onBackup,
  onLocked,
}: {
  siloName: string;
  sync: SyncStatus | null;
  onSynced: () => void;
  onKeys: () => void;
  onBackup: () => void;
  onLocked: () => void;
}) {
  const [keyCount, setKeyCount] = useState<number | null>(null);
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(null);
  const [lockAfter, setLockAfter] = useState<number | null>(null);
  const [choosingLock, setChoosingLock] = useState(false);
  const [aboutRecovery, setAboutRecovery] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [backupOn, setBackupOn] = useState<boolean | null>(null);
  const toast = useToast();

  useEffect(() => {
    api.listKeys().then((k) => setKeyCount(k.length), () => setKeyCount(null));
    api.recoveryStatus().then(setRecovery, () => setRecovery(null));
    api.lockAfter().then(setLockAfter, () => setLockAfter(null));
    api.backupStatus().then((s) => setBackupOn(s.photos || s.contacts), () => setBackupOn(null));
  }, []);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const report = await api.syncNow();
      if (report.needs_rejoin) toast("This phone was left out of a key change. Set it up again with the current recovery code.");
      else if (report.skipped) toast("A sync is already running.");
      else if (report.blobs_failed > 0) toast(`${report.blobs_failed} files could not be backed up. They will be retried.`);
      else toast(report.ops_pushed + report.ops_fetched > 0 ? "Synced." : "Already up to date.");
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
      <Icon size={20} color="var(--accent-hover)" />
      <span style={{ flex: 1, fontSize: "1rem" }}>{title}</span>
      <span className="muted" style={{ fontSize: "0.9rem" }}>{value}</span>
      <ChevronRight size={18} color="var(--text-dim)" />
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <SiloHeader siloName={siloName} sync={sync} />
      <div className="screen-body tight" style={{ paddingTop: 0, gap: 18 }}>
        {sync?.configured && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="label" style={{ padding: "0 4px" }}>Backup</span>
            <div className="panel" style={{ gap: 12, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Cloud size={20} color={waiting ? "var(--warning)" : "var(--success)"} />
                <span style={{ flex: 1 }}>{waiting ? `${waiting} ${waiting === 1 ? "change" : "changes"} waiting` : "Everything is backed up"}</span>
              </div>
              <button className="btn secondary" onClick={syncNow} disabled={syncing}>
                <RefreshCw size={18} />
                {syncing ? "Syncing" : "Sync now"}
              </button>
            </div>
          </div>
        )}
        {sync?.configured && (
          <div className="panel">{navRow(Images, "Phone backup", backupOn === null ? "" : backupOn ? "On" : "Off", onBackup, true)}</div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="label" style={{ padding: "0 4px" }}>Security</span>
          <div className="panel">
            {navRow(KeyRound, "Keys", keyCount === null ? "" : String(keyCount), onKeys, true)}
            {navRow(LockKeyhole, "Recovery code", recovery?.enabled ? "Active" : recovery ? "Not set" : "", () => setAboutRecovery(true))}
            {navRow(Smartphone, "Lock in the background", lockAfter === null ? "" : shortLock(lockAfter), () => setChoosingLock(true))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="label" style={{ padding: "0 4px" }}>Appearance</span>
          <div className="segmented" role="group" aria-label="Theme">
            {(
              [
                ["system", "System"],
                ["dark", "Dark"],
                ["light", "Light"],
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
        </div>
        <div className="spacer" />
        <button className="btn secondary" onClick={lockNow}>
          <LockKeyhole size={18} />
          Lock now
        </button>
      </div>

      <Sheet open={choosingLock} onClose={() => setChoosingLock(false)} title="Lock in the background">
        <p className="hint">How long the silo stays open after you switch to another app.</p>
        <div className="panel">
          {LOCK_CHOICES.map((c, i) => (
            <button key={c.seconds} className={`row${i > 0 ? " divide" : ""}`} style={{ minHeight: 56 }} onClick={() => void chooseLock(c.seconds)} aria-pressed={lockAfter === c.seconds}>
              <span style={{ flex: 1 }}>{c.label}</span>
              {lockAfter === c.seconds && <span style={{ color: "var(--accent-hover)", fontWeight: 700 }}>Selected</span>}
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet open={aboutRecovery} onClose={() => setAboutRecovery(false)} title="Recovery code">
        <p className="hint">
          {recovery?.enabled
            ? "This silo has a recovery code. It was shown once, when it was made, and is not stored anywhere it could be read back. Keep the paper copy safe: it opens the silo when every key is gone."
            : "This silo has no recovery code. Create one in SilentSilo on your computer: without it, losing every key means losing the silo."}
        </p>
        <button className="btn secondary" onClick={() => setAboutRecovery(false)}>
          Close
        </button>
      </Sheet>
    </div>
  );
}
