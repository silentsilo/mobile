import { api, type JoinPreview, type StoreConfigInput } from "../api";
import { StepBar } from "../ui/chrome";
import { StorageForm } from "../ui/StorageForm";

export function JoinStorage({
  onBack,
  onFound,
}: {
  onBack: () => void;
  onFound: (config: StoreConfigInput, preview: JoinPreview) => void;
}) {
  const look = async (config: StoreConfigInput) => {
    const preview = await api.previewJoin(config);
    if (!preview.vault_id) {
      throw "No silo was found in this storage. Check the details against SilentSilo on your computer.";
    }
    onFound(config, preview);
  };

  return (
    <div className="screen">
      <StepBar step={1} onBack={onBack} />
      <div className="screen-body">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 className="title">Where is the backup?</h1>
          <p className="hint">The same storage your silo syncs to from your computer.</p>
        </div>
        <StorageForm submitLabel="Continue" busyLabel="Looking for your silo" onSubmit={look} />
      </div>
    </div>
  );
}
