import { useEffect, useState } from "react";
import { api, type StorageView, type StoreConfigInput } from "../api";
import { formatAppError } from "../shared/errors";
import { TopBar, useToast } from "../ui/chrome";
import { StorageForm } from "../ui/StorageForm";

/** Storage a computer signs in to, which the phone does not do yet. */
const CLOUD: Record<string, string> = {
  onedrive: "OneDrive",
  dropbox: "Dropbox",
  "google-drive": "Google Drive",
};

/** Where the open silo backs up, changed from the phone. */
export function Storage({ onBack }: { onBack: () => void }) {
  const [current, setCurrent] = useState<StorageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    api.storageView().then(setCurrent, (e) => setError(formatAppError(e)));
  }, []);

  const save = async (config: StoreConfigInput) => {
    await api.saveStorage(config);
    toast("Saved. Syncing now.");
    void api.syncNow().catch(() => undefined);
    onBack();
  };

  return (
    <div className="screen">
      <TopBar onBack={onBack} backLabel="Silo" />
      <div className="screen-body tight" style={{ gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
          <h1 className="title">Backup storage</h1>
          <p className="hint">
            {current?.configured
              ? "Change the details when a password or address changed. A new place must be empty or hold this same silo."
              : "Not backed up. This silo is only on this phone."}
          </p>
          {current && current.copies > 1 && (
            <p className="hint small">This silo has {current.copies} copies. The phone changes the first. Manage the others in SilentSilo on your computer.</p>
          )}
          {current?.kind === "folder" && <p className="hint small">This silo backs up to a folder on a computer, which the phone cannot reach.</p>}
          {current && CLOUD[current.kind] && (
            <p className="hint small">
              This silo backs up to {CLOUD[current.kind]}
              {current.username ? ` (${current.username})` : ""}, set up on a computer. The phone cannot sign in to it yet.
            </p>
          )}
        </div>
        {error && <div className="notice error">{error}</div>}
        {current && <StorageForm current={current} submitLabel="Save" busyLabel="Checking the backup storage" onSubmit={save} />}
      </div>
    </div>
  );
}
