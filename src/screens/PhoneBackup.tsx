import { Check, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BackupSettings, type BackupStatus, type MediaFolder } from "../api";
import { formatAppError } from "../shared/errors";
import { formatBytes } from "../shared/format";
import { Notice, Sheet, ToggleRow, TopBar, useToast } from "../ui/chrome";

/** How long ago, in the words desktop's status lines use. */
function ago(seconds: number) {
  if (!seconds) return "Not yet";
  const minutes = Math.round((Date.now() / 1000 - seconds) / 60);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "An hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

export function PhoneBackup({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // Turning photos or videos on asks whether to send what is already there.
  const [askExisting, setAskExisting] = useState<"photos" | "videos" | null>(null);
  const [folders, setFolders] = useState<MediaFolder[] | null>(null);
  const [choosingFolders, setChoosingFolders] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [waiting, setWaiting] = useState<number | null>(null);
  // Said before Android asks for access, the first time each kind is turned on.
  const [disclosing, setDisclosing] = useState<"photos" | "videos" | "contacts" | null>(null);
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
      videos: status.videos,
      folders: status.folders,
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

  const readFolders = async () => {
    try {
      const listed = await api.mediaFolders();
      setFolders(listed);
      return listed;
    } catch (e) {
      toast(formatAppError(e));
      return null;
    }
  };

  // Counted first, so "All" says what it would send.
  const askAboutExisting = (kind: "photos" | "videos") => {
    setAskExisting(kind);
    if (!folders) void readFolders();
  };

  const openFolders = async () => {
    setChosen(status?.folders ?? []);
    setChoosingFolders(true);
    if (!folders) await readFolders();
  };

  // What "all existing" would send, in the folders backed up.
  const existing = (kind: "photos" | "videos") => {
    if (!folders || !status) return null;
    const inScope = folders.filter((f) => status.folders.length === 0 || status.folders.includes(f.id));
    const count = inScope.reduce((n, f) => n + (kind === "photos" ? f.photos : f.videos), 0);
    // Folder sizes cover photos and videos together; shared out by count.
    const bytes = inScope.reduce((n, f) => n + (f.photos + f.videos ? (f.bytes * (kind === "photos" ? f.photos : f.videos)) / (f.photos + f.videos) : 0), 0);
    return { count, bytes };
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
    <ToggleRow label={label} hint={hint} checked={on} busy={busy} onChange={onChange} first={first} />
  );

  const on = !!status && (status.photos || status.videos || status.contacts);
  const media = !!status && (status.photos || status.videos);
  const offer = askExisting ? existing(askExisting) : null;

  return (
    <div className="screen">
      <TopBar onBack={onBack} backLabel="Silo" />
      <div className="screen-body tight" style={{ gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
          <h1 className="title">Phone backup</h1>
          <p className="hint">
            New photos, videos and contacts are encrypted on this phone and sent to backup storage, even while the silo is
            locked. They show up under Files, Phone backup, the next time the silo is opened here or on a computer with
            SilentSilo 1.1 or later. The originals stay on the phone.
          </p>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {status && (
          <>
            <div className="panel">
              {toggle("Photos", "Every new photo", status.photos, () => (status.photos ? void apply({ photos: false }) : status.photosAllowed ? askAboutExisting("photos") : setDisclosing("photos")), true)}
              {toggle("Videos", "Large: best left to Wi-Fi", status.videos, () => (status.videos ? void apply({ videos: false }) : status.videosAllowed ? askAboutExisting("videos") : setDisclosing("videos")))}
              {toggle("Contacts", "Once a day, when they change", status.contacts, () => (status.contacts ? void apply({ contacts: false }) : status.contactsAllowed ? void apply({ contacts: true }) : setDisclosing("contacts")))}
            </div>
            {media && (
              <div className="panel">
                <button className="row" style={{ minHeight: 60 }} onClick={() => void openFolders()}>
                  <span className="row-text">
                    <span className="row-title">Folders</span>
                    <span className="row-sub">Camera, screenshots, messaging apps</span>
                  </span>
                  <span className="muted">
                    {status.folders.length === 0 ? "All" : `${status.folders.length} chosen`}
                  </span>
                  <ChevronRight size={18} color="var(--text-dim)" />
                </button>
              </div>
            )}
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
                {status.lastError && <Notice tone="error">{status.lastError}</Notice>}
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

      <Sheet
        open={disclosing !== null}
        onClose={() => setDisclosing(null)}
        title={disclosing === "contacts" ? "Back up your contacts" : disclosing === "videos" ? "Back up your videos" : "Back up your photos"}
      >
        <p className="hint">
          {disclosing === "contacts"
            ? "SilentSilo reads the contacts on this phone, names, numbers, addresses and the rest of each card, once a day when they change."
            : `SilentSilo reads the ${disclosing === "videos" ? "videos" : "photos"} in the gallery folders you choose, with the place they were taken when the file records it, including ones added later while the app is closed.`}
        </p>
        <p className="hint">
          Each copy is encrypted on this phone before it is sent to this silo's backup storage. Nothing is sent to SilentSilo.
          Turning this off stops it.
        </p>
        <p className="hint small">Android asks for access next.</p>
        <button
          className="btn"
          onClick={() => {
            const kind = disclosing;
            setDisclosing(null);
            if (kind === "contacts") void apply({ contacts: true });
            else if (kind) askAboutExisting(kind);
          }}
        >
          Continue
        </button>
        <button className="btn secondary" onClick={() => setDisclosing(null)}>
          Cancel
        </button>
      </Sheet>

      <Sheet open={askExisting !== null} onClose={() => setAskExisting(null)} title={askExisting === "videos" ? "Videos already on this phone" : "Photos already on this phone"}>
        <p className="hint">Back up only what you take from now on, or everything already on the phone as well.</p>
        {offer && (
          <p className="hint">
            {offer.count.toLocaleString()} {askExisting} in the folders backed up, about {formatBytes(offer.bytes)}. Check that the
            silo's backup storage has room before choosing all.
          </p>
        )}
        <button
          className="btn"
          onClick={() => {
            const kind = askExisting;
            setAskExisting(null);
            void apply({ [kind ?? "photos"]: true, includeExisting: false });
          }}
        >
          Only new ones
        </button>
        <button
          className="btn secondary"
          onClick={() => {
            const kind = askExisting;
            setAskExisting(null);
            void apply({ [kind ?? "photos"]: true, includeExisting: true });
          }}
        >
          {offer ? `All of them (${formatBytes(offer.bytes)})` : "All of them"}
        </button>
      </Sheet>

      <Sheet open={choosingFolders} onClose={() => setChoosingFolders(false)} title="Folders to back up">
        <p className="hint">Nothing ticked backs up every folder. A folder added later sends what arrives in it from then on.</p>
        {folders === null && <p className="hint">Reading the gallery…</p>}
        {folders && (
          <div className="panel" style={{ maxHeight: "45vh", overflowY: "auto" }}>
            {folders.map((folder, i) => {
              const ticked = chosen.includes(folder.id);
              return (
                <button
                  key={folder.id}
                  className={`row${i ? " divide" : ""}`}
                  style={{ minHeight: 56 }}
                  role="checkbox"
                  aria-checked={ticked}
                  onClick={() => setChosen(ticked ? chosen.filter((id) => id !== folder.id) : [...chosen, folder.id])}
                >
                  <span className="row-text">
                    <span className="row-title">{folder.name}</span>
                    <span className="row-sub">
                      {folder.photos.toLocaleString()} photos · {folder.videos.toLocaleString()} videos · {formatBytes(folder.bytes)}
                    </span>
                  </span>
                  <span className="checkmark" aria-hidden>
                    <Check size={16} strokeWidth={3} />
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <button
          className="btn"
          onClick={() => {
            setChoosingFolders(false);
            void apply({ folders: chosen });
          }}
        >
          Save
        </button>
      </Sheet>
    </div>
  );
}
