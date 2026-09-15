import { useState } from "react";
import { api, type StoreConfigInput } from "../api";
import { Sheet, StepBar } from "../ui/chrome";
import { StorageForm } from "../ui/StorageForm";

/** Where a silo made on this phone backs up, and its first sync. */
export function CreateStorage({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [later, setLater] = useState(false);

  const save = async (config: StoreConfigInput) => {
    await api.saveStorage(config);
    await api.syncNow().catch(() => undefined);
    onDone();
  };

  return (
    <div className="screen">
      <StepBar step={3} onBack={onBack} />
      <div className="screen-body">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 className="title">Where should it back up?</h1>
          <p className="hint">An empty bucket or folder of your own. Your computers join the silo from there.</p>
        </div>
        <StorageForm submitLabel="Save and back up" busyLabel="Checking the storage" onSubmit={save} />
        <button className="text-btn" style={{ alignSelf: "center" }} onClick={() => setLater(true)}>
          Set up later
        </button>
      </div>

      <Sheet open={later} onClose={() => setLater(false)} title="No backup yet?">
        <p className="hint">
          Until it has storage, the silo lives only on this phone: lose the phone and it is gone, recovery code or not. Add
          storage from Silo, Storage.
        </p>
        <button className="btn secondary" onClick={onDone}>
          Continue without a backup
        </button>
        <button className="btn" onClick={() => setLater(false)}>
          Set up storage now
        </button>
      </Sheet>
    </div>
  );
}
