import { Check, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BackupSettings, type BackupStatus, type MediaFolder } from "../api";
import { formatAppError } from "../shared/errors";
import { formatBytes } from "../shared/format";
import { Notice, Sheet, Skeleton, ToggleRow, TopBar, useToast } from "../ui/chrome";
import { dateLocale, t, useLocale } from "../i18n";

/** The silo folder backups land in; its name stays as the phone writes it. */
const BACKUP_FOLDER = "Phone backup";

/** A count with the language's digit grouping. */
const num = (n: number) => n.toLocaleString(dateLocale());

/** How long ago, in the words desktop's status lines use. */
function ago(seconds: number) {
  if (!seconds) return t("files.age_not_yet");
  const minutes = Math.round((Date.now() / 1000 - seconds) / 60);
  if (minutes < 1) return t("files.age_just_now");
  if (minutes < 60) return t("files.age_minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("files.age_hours", { count: hours });
  const days = Math.round(hours / 24);
  return days === 1 ? t("files.age_yesterday") : t("files.age_days", { count: days });
}

export function PhoneBackup({ onBack }: { onBack: () => void }) {
  useLocale();
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
      toast(t("files.backup_run_soon"));
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
      <TopBar onBack={onBack} backLabel={t("files.back_silo")} />
      <div className="screen-body tight" style={{ gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
          <h1 className="title">{t("files.backup_title")}</h1>
          <p className="hint">{t("files.backup_intro", { folder: BACKUP_FOLDER })}</p>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {!status && !error && <Skeleton avatar={false} rows={3} />}
        {status && (
          <>
            <div className="panel">
              {toggle(t("files.backup_photos"), t("files.backup_photos_hint"), status.photos, () => (status.photos ? void apply({ photos: false }) : status.photosAllowed ? askAboutExisting("photos") : setDisclosing("photos")), true)}
              {toggle(t("files.backup_videos"), t("files.backup_videos_hint"), status.videos, () => (status.videos ? void apply({ videos: false }) : status.videosAllowed ? askAboutExisting("videos") : setDisclosing("videos")))}
              {toggle(t("files.backup_contacts"), t("files.backup_contacts_hint"), status.contacts, () => (status.contacts ? void apply({ contacts: false }) : status.contactsAllowed ? void apply({ contacts: true }) : setDisclosing("contacts")))}
            </div>
            {media && (
              <div className="panel">
                <button className="row" style={{ minHeight: 60 }} onClick={() => void openFolders()}>
                  <span className="row-text">
                    <span className="row-title">{t("files.backup_folders")}</span>
                    <span className="row-sub">{t("files.backup_folders_hint")}</span>
                  </span>
                  <span className="muted">
                    {status.folders.length === 0
                      ? t("files.backup_folders_all")
                      : t("files.backup_folders_chosen", { count: status.folders.length })}
                  </span>
                  <ChevronRight size={18} color="var(--text-dim)" />
                </button>
              </div>
            )}
            {on && (
              <div className="panel">
                {toggle(t("files.backup_wifi_only"), t("files.backup_wifi_only_hint"), status.wifiOnly, () => void apply({ wifiOnly: !status.wifiOnly }), true)}
                {toggle(t("files.backup_charging_only"), t("files.backup_charging_only_hint"), status.chargingOnly, () => void apply({ chargingOnly: !status.chargingOnly }))}
                {toggle(t("files.backup_remind"), t("files.backup_remind_hint"), status.remind, () => void apply({ remind: !status.remind }))}
              </div>
            )}
            {on && (
              <div className="panel" style={{ gap: 10, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="muted">{t("files.backup_sent")}</span>
                  <span>{num(status.sent)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="muted">{t("files.backup_waiting")}</span>
                  <span>{waiting === null ? t("files.backup_unknown") : num(waiting)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="muted">{t("files.backup_last_run")}</span>
                  <span>{ago(status.lastRun)}</span>
                </div>
                {status.lastError && <Notice tone="error">{status.lastError}</Notice>}
                <button className="btn secondary" onClick={runNow} disabled={busy}>
                  <RefreshCw size={18} />
                  {t("files.backup_now")}
                </button>
              </div>
            )}
            {on && (
              <p className="hint" style={{ padding: "0 4px" }}>
                {t("files.backup_battery_hint")}
              </p>
            )}
          </>
        )}
      </div>

      <Sheet
        open={disclosing !== null}
        onClose={() => setDisclosing(null)}
        title={
          disclosing === "contacts"
            ? t("files.backup_disclose_contacts_title")
            : disclosing === "videos"
              ? t("files.backup_disclose_videos_title")
              : t("files.backup_disclose_photos_title")
        }
      >
        <p className="hint">
          {disclosing === "contacts"
            ? t("files.backup_disclose_contacts")
            : disclosing === "videos"
              ? t("files.backup_disclose_videos")
              : t("files.backup_disclose_photos")}
        </p>
        <p className="hint">{t("files.backup_disclose_storage")}</p>
        <p className="hint small">{t("files.backup_disclose_next")}</p>
        <button
          className="btn"
          onClick={() => {
            const kind = disclosing;
            setDisclosing(null);
            if (kind === "contacts") void apply({ contacts: true });
            else if (kind) askAboutExisting(kind);
          }}
        >
          {t("files.continue")}
        </button>
        <button className="btn secondary" onClick={() => setDisclosing(null)}>
          {t("common.cancel")}
        </button>
      </Sheet>

      <Sheet open={askExisting !== null} onClose={() => setAskExisting(null)} title={askExisting === "videos" ? t("files.backup_existing_videos_title") : t("files.backup_existing_photos_title")}>
        <p className="hint">{t("files.backup_existing_text")}</p>
        {offer && (
          <p className="hint">
            {t(askExisting === "videos" ? "files.backup_existing_videos" : "files.backup_existing_photos", {
              count: offer.count,
              number: num(offer.count),
              size: formatBytes(offer.bytes),
            })}
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
          {t("files.backup_only_new")}
        </button>
        <button
          className="btn secondary"
          onClick={() => {
            const kind = askExisting;
            setAskExisting(null);
            void apply({ [kind ?? "photos"]: true, includeExisting: true });
          }}
        >
          {offer ? t("files.backup_all_size", { size: formatBytes(offer.bytes) }) : t("files.backup_all")}
        </button>
      </Sheet>

      <Sheet open={choosingFolders} onClose={() => setChoosingFolders(false)} title={t("files.backup_folders_title")}>
        <p className="hint">{t("files.backup_folders_text")}</p>
        {folders === null && <p className="hint">{t("files.reading_gallery")}</p>}
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
                      {t("files.folder_photos", { count: folder.photos, number: num(folder.photos) })} ·{" "}
                      {t("files.folder_videos", { count: folder.videos, number: num(folder.videos) })} · {formatBytes(folder.bytes)}
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
          {t("common.save")}
        </button>
      </Sheet>
    </div>
  );
}
