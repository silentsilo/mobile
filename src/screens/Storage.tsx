import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type CopyView, type StorageView, type StoreConfigInput } from "../api";
import { formatBytes } from "../shared/format";
import { formatAppError } from "../shared/errors";
import { t, useLocale } from "../i18n";
import { Notice, Sheet, Skeleton, TopBar, useToast } from "../ui/chrome";
import { StorageForm } from "../ui/StorageForm";

const BRAND_NAME: Record<string, string> = {
  "web-dav": "WebDAV",
  sftp: "SFTP",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
  "google-drive": "Google Drive",
};

function kindName(kind: string): string {
  if (kind === "s3") return t("silo.kind_s3");
  if (kind === "folder") return t("silo.kind_folder");
  return BRAND_NAME[kind] ?? kind;
}

/** Where a copy is, in one line: the account, bucket, server or folder. */
function whereIs(config: CopyView["config"]): string {
  switch (config.kind) {
    case "s3":
      return config.prefix ? `${config.bucket}/${config.prefix}` : config.bucket;
    case "web-dav":
      return config.url;
    case "sftp":
      return `${config.username}@${config.host}`;
    case "folder":
      return config.path;
    default:
      return t("silo.where_cloud", { account: config.account, folder: config.folder });
  }
}

/** How long ago, coarse, in words that fit "Last written {duration} ago". */
function describeDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s <= 1 ? t("silo.duration_moment") : t("silo.duration_seconds", { count: s });
  const minutes = Math.round(s / 60);
  if (minutes < 60) return t("silo.duration_minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("silo.duration_hours", { count: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return t("silo.duration_days", { count: days });
  const months = Math.round(days / 30);
  if (months < 12) return t("silo.duration_months", { count: months });
  return t("silo.duration_years", { count: Math.round(months / 12) });
}

function written(copy: CopyView): string {
  return copy.lastSuccess > 0
    ? t("silo.copy_last_written", { duration: describeDuration(Date.now() / 1000 - copy.lastSuccess) })
    : t("silo.copy_never");
}

/** Where the open silo backs up: the main copy, the others, and a new one. */
export function Storage({ onBack }: { onBack: () => void }) {
  useLocale();
  const [current, setCurrent] = useState<StorageView | null>(null);
  const [copies, setCopies] = useState<CopyView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<CopyView | null>(null);
  /// A copy just added, offered a fill from the main one.
  const [toFill, setToFill] = useState<CopyView | null>(null);
  const [filling, setFilling] = useState<{ done: number; total: number } | null>(null);
  const [stopping, setStopping] = useState(false);
  const toast = useToast();
  useEffect(() => {
    const stop = listen<{ bytes_done: number; bytes_total: number }>("fill-progress", (event) => {
      setFilling({ done: event.payload.bytes_done, total: event.payload.bytes_total });
    });
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, []);

  const load = useCallback(() => {
    api.storageView().then(setCurrent, (e) => setError(formatAppError(e)));
    api.copies().then(setCopies, (e) => setError(formatAppError(e)));
  }, []);
  useEffect(load, [load]);
  // Each finished pass changes when a copy was last written.
  useEffect(() => {
    const stop = listen("sync-report", () => {
      api.copies().then(setCopies, () => undefined);
    });
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, []);

  const save = async (config: StoreConfigInput) => {
    await api.saveStorage(config);
    toast(t("silo.toast_saved"));
    void api.syncNow().catch(() => undefined);
    setEditing(false);
    load();
  };

  const add = async (config: StoreConfigInput) => {
    const before = new Set((copies ?? []).map((c) => c.id));
    await api.addCopy(config);
    toast(t("silo.toast_copy_added"));
    void api.syncNow().catch(() => undefined);
    setAdding(false);
    load();
    // The records go at once; the files would only follow a hundred a day.
    const after = await api.copies().catch(() => null);
    const added = after?.find((c) => !before.has(c.id));
    if (added) setToFill(added);
  };

  const fill = async (copy: CopyView) => {
    setToFill(null);
    setStopping(false);
    setFilling({ done: 0, total: 0 });
    await api.setBusy(true).catch(() => undefined);
    try {
      await api.fillCopy(copy.id);
      toast(t("silo.toast_filled"));
      load();
    } catch (e) {
      if (String(e) !== "Stopped.") setError(formatAppError(e));
    } finally {
      setFilling(null);
      await api.setBusy(false).catch(() => undefined);
    }
  };

  const remove = async (copy: CopyView) => {
    setRemoving(null);
    try {
      await api.removeCopy(copy.id);
      toast(t("silo.toast_copy_removed"));
      load();
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  const main = copies?.[0];
  const others = copies?.slice(1) ?? [];

  return (
    <div className="screen">
      <TopBar onBack={onBack} backLabel={t("silo.tab_name")} />
      <div className="screen-body tight" style={{ gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
          <h1 className="title">{t("silo.row_storage")}</h1>
          {copies && copies.length === 0 && <p className="hint">{t("silo.storage_none")}</p>}
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {filling && (
          <div className="notice" role="status" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span>
              {filling.total > 0
                ? t("silo.filling", { done: formatBytes(filling.done), total: formatBytes(filling.total) })
                : t("silo.filling_start")}
            </span>
            <button
              className="btn secondary"
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                void api.stopFill().catch(() => undefined);
              }}
            >
              {stopping ? t("silo.fill_stopping") : t("silo.fill_stop")}
            </button>
          </div>
        )}
        {!copies && !error && <Skeleton avatar={false} rows={2} />}

        {copies && copies.length === 0 && current && (
          <StorageForm current={current} submitLabel={t("common.save")} busyLabel={t("silo.checking_storage")} onSubmit={save} />
        )}

        {main && !editing && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="label" style={{ padding: "0 4px" }}>
              {t("silo.main_copy")}
            </span>
            <div className="panel">
              <div className="row" style={{ minHeight: 64, padding: "10px 16px" }}>
                <div className="row-text">
                  <span className="row-title">{kindName(main.config.kind)}</span>
                  <span className="row-sub">{whereIs(main.config)}</span>
                  <span className="row-sub">{written(main)}</span>
                </div>
              </div>
            </div>
            {main.config.kind === "folder" ? (
              <p className="hint small">{t("silo.folder_unreachable")}</p>
            ) : (
              <button className="btn secondary" onClick={() => setEditing(true)}>
                {t("silo.change")}
              </button>
            )}
          </div>
        )}

        {main && editing && current && (
          <>
            <p className="hint">{t("silo.change_hint")}</p>
            <StorageForm current={current} submitLabel={t("common.save")} busyLabel={t("silo.checking_storage")} onSubmit={save} />
            <button className="btn secondary" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </button>
          </>
        )}

        {main && !editing && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="label" style={{ padding: "0 4px" }}>
              {t("silo.other_copies")}
            </span>
            {others.length > 0 ? (
              <div className="panel">
                {others.map((copy) => (
                  <div key={copy.id} className="row" style={{ minHeight: 64, padding: "10px 16px" }}>
                    <div className="row-text">
                      <span className="row-title">{copy.label || kindName(copy.config.kind)}</span>
                      <span className="row-sub">{whereIs(copy.config)}</span>
                      <span className="row-sub">{written(copy)}</span>
                    </div>
                    <button className="text-btn" onClick={() => setRemoving(copy)}>
                      {t("silo.remove")}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="hint small" style={{ padding: "0 4px" }}>
                {t("silo.other_copies_hint")}
              </p>
            )}
            {!adding && (
              <button className="btn secondary" onClick={() => setAdding(true)}>
                {t("silo.add_another")}
              </button>
            )}
          </div>
        )}

        {adding && (
          <>
            <StorageForm submitLabel={t("silo.add_this_copy")} busyLabel={t("silo.checking_storage")} onSubmit={add} />
            <button className="btn secondary" onClick={() => setAdding(false)}>
              {t("common.cancel")}
            </button>
          </>
        )}
      </div>

      <Sheet open={toFill !== null} onClose={() => setToFill(null)} title={t("silo.fill_title")}>
        <p className="hint">{t("silo.fill_body")}</p>
        <button className="btn" onClick={() => toFill && void fill(toFill)}>
          {t("silo.fill_now")}
        </button>
        <button className="btn secondary" onClick={() => setToFill(null)}>
          {t("silo.fill_later")}
        </button>
      </Sheet>

      <Sheet open={removing !== null} onClose={() => setRemoving(null)} title={t("silo.remove_copy_title")}>
        <p className="hint">
          {removing ? t("silo.remove_copy_body", { where: `${kindName(removing.config.kind)}, ${whereIs(removing.config)}` }) : ""}
        </p>
        <button className="btn danger" onClick={() => removing && void remove(removing)}>
          {t("silo.remove")}
        </button>
        <button className="btn secondary" onClick={() => setRemoving(null)}>
          {t("common.cancel")}
        </button>
      </Sheet>
    </div>
  );
}
