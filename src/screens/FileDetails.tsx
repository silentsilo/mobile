import { Check, CloudDownload, Download, Eye, Folder, FolderInput, Pencil, Share2, SquareArrowOutUpRight, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { formatBytes, formatDate } from "../shared/format";
import type { FileEntry, FolderEntry } from "../shared/types";
import { Sheet, TopBar, useToast } from "../ui/chrome";
import { type HandOverHow } from "../ui/HandOver";
import { isIOS } from "../ui/platform";
import { fileIcon } from "./Files";
import { canPreview, kindOf } from "./Preview";
import { t, useLocale } from "../i18n";

/** A small image already on the phone is drawn at the top; anything larger
 * waits for Preview, so opening the page decrypts nothing big. */
const THUMB_LIMIT = 10 * 1024 * 1024;

/** "PDF", "JPG": the extension, or the type's second half without one. */
function typeLabel(file: FileEntry): string {
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot + 1) : "";
  if (ext) return ext.toUpperCase();
  return file.mime_type?.split("/").pop()?.toUpperCase() ?? "-";
}

/**
 * What a tap on a file opens: what it is and where it is, and what can be
 * done with it. Nothing is downloaded or decrypted until an action asks:
 * most files cannot be shown inside the app anyway, and a large one only in
 * storage would come down just to say so.
 */
export function FileDetails({
  file: initial,
  siloName,
  onBack,
  onPreview,
  onChanged,
}: {
  file: FileEntry;
  siloName: string;
  onBack: () => void;
  onPreview: (file: FileEntry) => void;
  /** Renamed, moved or trashed: the list reloads. */
  onChanged: () => void;
}) {
  useLocale();
  const toast = useToast();
  const [file, setFile] = useState(initial);
  const [onPhone, setOnPhone] = useState<boolean | null>(null);
  const [folders, setFolders] = useState<FolderEntry[] | null>(null);
  const [busy, setBusy] = useState<HandOverHow | null>(null);
  const [download, setDownload] = useState<{ done: number; total: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(file.name);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    api.fileOnPhone(file.id).then(setOnPhone, () => setOnPhone(null));
    api.listAllFolders().then(setFolders, () => setFolders(null));
  }, [file.id]);
  useEffect(() => {
    const stop = listen<{ file_id: string; done: number; total: number }>("file-download", (event) => {
      if (event.payload.file_id === file.id) setDownload(event.payload);
    });
    return () => {
      void stop.then((off) => off());
    };
  }, [file.id]);

  const folder = folders?.find((f) => f.id === file.folder_id);
  const location = !folder || folder.path === "/" ? siloName : `${siloName}${folder.path}`;
  const previewable = canPreview(file);
  const thumb = kindOf(file) === "image" && onPhone === true && file.size_bytes <= THUMB_LIMIT;

  const handOver = async (how: HandOverHow) => {
    setBusy(how);
    try {
      if ((await api.openWith(file.id, how)) && how === "save") toast(t("files.saved_to_phone"));
      // What came down from storage is on the phone now.
      api.fileOnPhone(file.id).then(setOnPhone, () => undefined);
    } catch (e) {
      toast(formatAppError(e));
    } finally {
      setBusy(null);
      setDownload(null);
    }
  };

  const star = async () => {
    try {
      await api.setFavorite({ ...file, kind: "file" }, !file.favorite);
      setFile({ ...file, favorite: !file.favorite });
      onChanged();
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const rename = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      setFile(await api.renameFile(file.id, name));
      setRenaming(false);
      onChanged();
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const moveTo = async (destination: FolderEntry) => {
    setMoving(false);
    try {
      setFile(await api.moveFile(file.id, destination.id));
      toast(t("files.moved_one"));
      onChanged();
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const trash = async () => {
    try {
      await api.trashFile(file.id);
      toast(t("files.trashed_one"), {
        label: t("files.undo"),
        run: () => void api.restoreFile(file.id).then(onChanged, (e) => toast(formatAppError(e))),
      });
      onChanged();
      onBack();
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const downloading =
    busy && download && download.total > 0 && download.done < download.total
      ? t("files.downloading_of", { done: formatBytes(download.done), total: formatBytes(download.total) })
      : busy
        ? t("files.getting_ready", { name: file.name, size: formatBytes(file.size_bytes) })
        : null;

  const action = (how: HandOverHow, Icon: typeof Download, label: string) => (
    <button className="file-action" aria-busy={busy === how} disabled={busy !== null} onClick={() => void handOver(how)}>
      <Icon size={22} className={busy === how ? "spin" : undefined} />
      <span>{label}</span>
    </button>
  );

  const rows: { label: string; value: string }[] = [
    { label: t("files.location"), value: location },
    { label: t("files.created"), value: formatDate(file.created_at) },
    { label: t("files.modified"), value: formatDate(file.updated_at) },
  ];

  return (
    <div className="screen">
      <TopBar
        onBack={onBack}
        backLabel={t("start.tab_files")}
        right={
          <button
            className="icon-btn"
            aria-pressed={file.favorite}
            aria-label={file.favorite ? t("files.unfavorite") : t("files.favorite")}
            onClick={() => void star()}
          >
            <Star size={22} fill={file.favorite ? "var(--warning)" : "none"} color={file.favorite ? "var(--warning)" : undefined} />
          </button>
        }
      />
      <div className="screen-body tight" style={{ gap: 18 }}>
        <div className="file-hero">
          {thumb ? (
            <button className="file-thumb" aria-label={t("files.preview")} onClick={() => onPreview(file)}>
              <img src={api.fileUrl(file.id)} alt="" />
            </button>
          ) : (
            <span className="file-hero-icon" aria-hidden>
              {fileIcon(file, 40)}
            </span>
          )}
          <h1 className="title headline file-hero-name">{file.name}</h1>
          <span className="muted small">
            {typeLabel(file)} · {formatBytes(file.size_bytes)}
          </span>
        </div>

        <div className="file-actions">
          {previewable && (
            <button className="btn" disabled={busy !== null} onClick={() => onPreview(file)}>
              <Eye size={18} />
              {t("files.preview")}
            </button>
          )}
          <div className="file-action-row">
            {isIOS ? (
              action("share", Share2, t("files.share_or_save"))
            ) : (
              <>
                {action("save", Download, t("files.save_to_phone"))}
                {action("share", Share2, t("files.share"))}
                {action("open", SquareArrowOutUpRight, t("files.open_with"))}
              </>
            )}
          </div>
          {downloading && (
            <p className="hint small" role="status">
              {downloading}
            </p>
          )}
        </div>

        <div className="panel">
          <div className="row" style={{ minHeight: 56, gap: 12 }}>
            {onPhone === false ? <CloudDownload size={20} color="var(--text-muted)" /> : <Check size={20} color="var(--success)" />}
            <span className="row-text">
              <span className="row-title" style={{ whiteSpace: "normal" }}>
                {onPhone === false ? t("files.in_storage_only", { size: formatBytes(file.size_bytes) }) : onPhone ? t("files.on_phone") : "…"}
              </span>
            </span>
          </div>
          {rows.map((row) => (
            <div key={row.label} className="row divide" style={{ minHeight: 60 }}>
              <span className="row-text" style={{ gap: 3 }}>
                <span className="label" style={{ color: "var(--text-dim)", letterSpacing: "0.03em" }}>
                  {row.label}
                </span>
                <span className="field-value">{row.value}</span>
              </span>
            </div>
          ))}
        </div>

        <div className="panel">
          <button className="row" style={{ minHeight: 56 }} onClick={() => setRenaming(true)}>
            <Pencil size={20} color="var(--accent-text)" />
            <span style={{ flex: 1 }}>{t("files.rename")}</span>
          </button>
          <button className="row divide" style={{ minHeight: 56 }} onClick={() => setMoving(true)}>
            <FolderInput size={20} color="var(--accent-text)" />
            <span style={{ flex: 1 }}>{t("files.move_elsewhere")}</span>
          </button>
          <button className="row divide" style={{ minHeight: 56, color: "var(--danger)" }} onClick={() => void trash()}>
            <Trash2 size={20} />
            <span style={{ flex: 1 }}>{t("files.move_to_trash")}</span>
          </button>
        </div>
      </div>

      <Sheet open={renaming} onClose={() => setRenaming(false)} title={t("files.rename")}>
        <div className="input">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && void rename()} />
        </div>
        <button className="btn" disabled={!newName.trim()} onClick={() => void rename()}>
          {t("common.save")}
        </button>
      </Sheet>

      <Sheet open={moving} onClose={() => setMoving(false)} title={t("files.move_named", { name: file.name })}>
        {folders === null ? (
          <p className="hint">{t("files.reading_folders")}</p>
        ) : (
          <div className="panel" style={{ maxHeight: "50vh", overflowY: "auto" }}>
            {[...folders]
              .sort((a, b) => a.path.localeCompare(b.path))
              .map((f, i) => {
                const depth = f.path === "/" ? 0 : f.path.split("/").length - 1;
                const here = f.id === file.folder_id;
                return (
                  <button
                    key={f.id}
                    className={`row${i ? " divide" : ""}`}
                    style={{ minHeight: 52, paddingLeft: 16 + depth * 16 }}
                    disabled={here}
                    onClick={() => void moveTo(f)}
                  >
                    <Folder size={18} color="var(--accent-text)" />
                    <span className="row-title" style={{ flex: 1 }}>
                      {f.path === "/" ? siloName : f.name}
                    </span>
                    {here && <Check size={18} color="var(--text-muted)" />}
                  </button>
                );
              })}
          </div>
        )}
      </Sheet>
    </div>
  );
}
