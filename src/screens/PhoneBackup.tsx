import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BackupSettings, type BackupStatus } from "../api";
import { formatAppError } from "../shared/errors";
import { formatBytes } from "../shared/format";
import { Sheet, TopBar, useToast } from "../ui/chrome";

function ago(seconds: number) {
  if (!seconds) return "Not yet";
  const minutes = Math.round((Date.now() / 1000 - seconds) / 60);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

export function PhoneBackup({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [askExisting, setAskExisting] = useState(false);
  const [onPhone, setOnPhone] = useState<{ count: number; bytes: number } | null>(null);
  const [waiting, setWaiting] = useState<number | null>(null);
  const toast = useToast();

  const load = useCallback(() => {
    api.backupStatus().then(setStatus, (e) => setError(formatAppError(e)));
  }, []);

  // The job runs on its own schedule, so what it did is read again while
  // this screen is open.
  useEffect(() => {
    load();
    api.backupWaiting().then(setWaiting, () => setWaiting(null));
    const timer = window.setInterval(() => {
      api.backupStatus().then((s) => !saving.current && setStatus(s), () => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  const apply = async (change: Partial<BackupSettings>) => {
    if (!status || busy) return;
    const settings = {
      photos: status.photos,
      contacts: status.contacts,
      wifiOnly: status.wifiOnly,
      chargingOnly: status.chargingOnly,
      remind: status.remind,
      includeExisting: false,
      ...change,
    };
    // The switch moves now; the phone may take a few seconds to reach storage.
    setStatus({ ...status, ...settings });
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.configureBackup(settings));
    } catch (e) {
      setError(formatAppError(e));
      load();
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  // Counted first, so "All photos" says what it would send.
  const askAboutExisting = async () => {
    setOnPhone(null);
    setAskExisting(true);
    try {
      setOnPhone(await api.photoCount());
    } catch {
      setOnPhone(null);
    }
  };

  const runNow = async () => {
    try {
      await api.runBackupNow();
      toast("Backup will run as soon as the phone allows it.");
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const toggle = (label: string, hint: string, on: boolean, onChange: () => void, first = false) => (
    <div className={`row${first ? "" : " divide"}`} style={{ minHeight: 64 }}>
      <div className="row-text">
        <span className="row-title">{label}</span>
        <span className="row-sub">{hint}</span>
      </div>
      <button className="switch" role="switch" aria-checked={on} aria-label={label} aria-busy={busy} onClick={onChange} />
    </div>
  );

  const on = !!status && (status.photos || status.contacts);

  return (
    <div className="screen">
      <TopBar onBack={onBack} backLabel="Silo" />
      <div className="screen-body tight" style={{ gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
          <h1 className="title">Phone backup</h1>
          <p className="hint">
            New photos and your contacts are encrypted on this phone and sent to the silo's storage on their own, even while the
            silo is locked. They join the silo, under Files, Phone backup, the next time it is opened on this phone or on a computer
            running SilentSilo 1.1 or later. Until then they wait in storage, still encrypted, and the originals stay on the phone.
          </p>
        </div>
        {error && <div className="notice error">{error}</div>}
        {status && (
          <>
            <div className="panel">
              {toggle("Photos", "Every new photo", status.photos, () => (status.photos ? void apply({ photos: false }) : void askAboutExisting()), true)}
              {toggle("Contacts", "Once a day, when they change", status.contacts, () => void apply({ contacts: !status.contacts }))}
            </div>
            {on && (
              <div className="panel">
                {toggle("Only on Wi-Fi", "No mobile data", status.wifiOnly, () => void apply({ wifiOnly: !status.wifiOnly }), true)}
                {toggle("Only while charging", "Waits for the charger", status.chargingOnly, () => void apply({ chargingOnly: !status.chargingOnly }))}
                {toggle("Remind me", "When items wait more than 3 days", status.remind, () => void apply({ remind: !status.remind }))}
              </div>
            )}
            {on && (
              <div className="panel" style={{ gap: 10, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="muted">Sent from this phone</span>
                  <span>{status.sent}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="muted">Waiting to join the silo</span>
                  <span>{waiting === null ? "Unknown" : waiting}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="muted">Last run</span>
                  <span>{ago(status.lastRun)}</span>
                </div>
                {status.lastError && <div className="notice error">{status.lastError}</div>}
                <button className="btn secondary" onClick={runNow} disabled={busy}>
                  <RefreshCw size={18} />
                  Back up now
                </button>
              </div>
            )}
            {on && (
              <p className="hint" style={{ padding: "0 4px" }}>
                Android runs backups when it sees fit. If they stop, set SilentSilo's battery use to Unrestricted in the phone's
                settings.
              </p>
            )}
          </>
        )}
      </div>

      <Sheet open={askExisting} onClose={() => setAskExisting(false)} title="Photos already on this phone">
        <p className="hint">Back up only the photos you take from now on, or every photo already on the phone as well.</p>
        {onPhone && (
          <p className="hint">
            This phone holds {onPhone.count.toLocaleString()} photos, {formatBytes(onPhone.bytes)} in all. Check that the silo's storage has
            room for them before choosing all.
          </p>
        )}
        <button
          className="btn"
          onClick={() => {
            setAskExisting(false);
            void apply({ photos: true, includeExisting: false });
          }}
        >
          Only new photos
        </button>
        <button
          className="btn secondary"
          onClick={() => {
            setAskExisting(false);
            void apply({ photos: true, includeExisting: true });
          }}
        >
          {onPhone ? `All photos (${formatBytes(onPhone.bytes)})` : "All photos"}
        </button>
      </Sheet>
    </div>
  );
}
