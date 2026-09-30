import { useCallback, useEffect, useState } from "react";
import { api, type CopyView, type StorageView, type StoreConfigInput } from "../api";
import { formatAppError } from "../shared/errors";
import { formatAge } from "../shared/format";
import { Sheet, TopBar, useToast } from "../ui/chrome";
import { StorageForm } from "../ui/StorageForm";

const KIND_NAME: Record<string, string> = {
  s3: "S3 bucket",
  "web-dav": "WebDAV",
  sftp: "SFTP",
  folder: "Folder on a computer",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
  "google-drive": "Google Drive",
};

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
      return `${config.account}, folder ${config.folder}`;
  }
}

function written(copy: CopyView): string {
  return copy.lastSuccess > 0 ? `Last written ${formatAge(copy.lastSuccess * 1000)}` : "Not written to yet";
}

/** Where the open silo backs up: the main copy, the others, and a new one. */
export function Storage({ onBack }: { onBack: () => void }) {
  const [current, setCurrent] = useState<StorageView | null>(null);
  const [copies, setCopies] = useState<CopyView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<CopyView | null>(null);
  const toast = useToast();

  const load = useCallback(() => {
    api.storageView().then(setCurrent, (e) => setError(formatAppError(e)));
    api.copies().then(setCopies, (e) => setError(formatAppError(e)));
  }, []);
  useEffect(load, [load]);

  const save = async (config: StoreConfigInput) => {
    await api.saveStorage(config);
    toast("Saved. Syncing now.");
    void api.syncNow().catch(() => undefined);
    setEditing(false);
    load();
  };

  const add = async (config: StoreConfigInput) => {
    await api.addCopy(config);
    toast("Copy added. Syncing now.");
    void api.syncNow().catch(() => undefined);
    setAdding(false);
    load();
  };

  const remove = async (copy: CopyView) => {
    setRemoving(null);
    try {
      await api.removeCopy(copy.id);
      toast("Copy removed. Nothing there was deleted.");
      load();
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  const main = copies?.[0];
  const others = copies?.slice(1) ?? [];

  return (
    <div className="screen">
      <TopBar onBack={onBack} backLabel="Silo" />
      <div className="screen-body tight" style={{ gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
          <h1 className="title">Backup storage</h1>
          {copies && copies.length === 0 && <p className="hint">Not backed up. This silo is only on this phone.</p>}
        </div>
        {error && <div className="notice error">{error}</div>}

        {copies && copies.length === 0 && current && (
          <StorageForm current={current} submitLabel="Save" busyLabel="Checking the backup storage" onSubmit={save} />
        )}

        {main && !editing && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="label" style={{ padding: "0 4px" }}>
              Main copy
            </span>
            <div className="panel">
              <div className="row" style={{ minHeight: 64, padding: "10px 16px" }}>
                <div className="row-text">
                  <span className="row-title">{KIND_NAME[main.config.kind] ?? main.config.kind}</span>
                  <span className="row-sub">{whereIs(main.config)}</span>
                  <span className="row-sub">{written(main)}</span>
                </div>
              </div>
            </div>
            {main.config.kind === "folder" ? (
              <p className="hint small">A folder on a computer, which the phone cannot reach.</p>
            ) : (
              <button className="btn secondary" onClick={() => setEditing(true)}>
                Change
              </button>
            )}
          </div>
        )}

        {main && editing && current && (
          <>
            <p className="hint">
              Change the details when a password or address changed. A new place must be empty or hold this same silo.
            </p>
            <StorageForm current={current} submitLabel="Save" busyLabel="Checking the backup storage" onSubmit={save} />
            <button className="btn secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        )}

        {main && !editing && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="label" style={{ padding: "0 4px" }}>
              Other copies
            </span>
            {others.length > 0 ? (
              <div className="panel">
                {others.map((copy) => (
                  <div key={copy.id} className="row" style={{ minHeight: 64, padding: "10px 16px" }}>
                    <div className="row-text">
                      <span className="row-title">{copy.label || KIND_NAME[copy.config.kind] || copy.config.kind}</span>
                      <span className="row-sub">{whereIs(copy.config)}</span>
                      <span className="row-sub">{written(copy)}</span>
                    </div>
                    <button className="text-btn" onClick={() => setRemoving(copy)}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="hint small" style={{ padding: "0 4px" }}>
                One copy somewhere else, on another kind of storage, is what survives losing the first.
              </p>
            )}
            {!adding && (
              <button className="btn secondary" onClick={() => setAdding(true)}>
                Add another copy
              </button>
            )}
          </div>
        )}

        {adding && (
          <>
            <StorageForm submitLabel="Add this copy" busyLabel="Checking the backup storage" onSubmit={add} />
            <button className="btn secondary" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </>
        )}
      </div>

      <Sheet open={removing !== null} onClose={() => setRemoving(null)} title="Remove this copy?">
        <p className="hint">
          {removing ? `${KIND_NAME[removing.config.kind] ?? ""}, ${whereIs(removing.config)}` : ""} stops receiving this
          silo. Nothing there is deleted.
        </p>
        <button className="btn danger" onClick={() => removing && void remove(removing)}>
          Remove
        </button>
        <button className="btn secondary" onClick={() => setRemoving(null)}>
          Cancel
        </button>
      </Sheet>
    </div>
  );
}
