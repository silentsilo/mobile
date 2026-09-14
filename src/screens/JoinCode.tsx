import { ClipboardPaste } from "lucide-react";
import { useState } from "react";
import { api, type JoinPreview, type StoreConfigInput } from "../api";
import { formatAppError } from "../shared/errors";
import { isComplete } from "../shared/recoveryCode";
import { Field, StepBar, useToast } from "../ui/chrome";
import { RecoveryCodeInput } from "../ui/RecoveryCodeInput";

export function JoinCode({
  config,
  preview,
  onBack,
  onJoined,
}: {
  config: StoreConfigInput;
  preview: JoinPreview;
  onBack: () => void;
  onJoined: () => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("Personal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const paste = async () => {
    try {
      setCode(await navigator.clipboard.readText());
    } catch {
      toast("Long-press a box and paste there instead.");
    }
  };

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.joinWithRecovery(config, code, name.trim() || "Personal");
      onJoined();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <StepBar step={2} onBack={onBack} />
      <div className="screen-body" style={{ gap: 22 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 className="title">Enter your recovery code</h1>
          <p className="hint">The code you wrote down when the silo was made. Type it group by group, the way it is printed.</p>
          {preview.key_labels.length > 0 && (
            <p className="hint small">Keys that already open this silo: {preview.key_labels.join(", ")}.</p>
          )}
        </div>
        <RecoveryCodeInput value={code} onChange={setCode} disabled={busy} autoFocus />
        <button className="btn secondary" onClick={paste} disabled={busy}>
          <ClipboardPaste size={20} />
          Paste from clipboard
        </button>
        <Field label="Name for this silo on the phone">
          <div className="input">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </Field>
        {error && <div className="notice error">{error}</div>}
        <div className="spacer" />
        <button className="btn" disabled={!isComplete(code) || busy} onClick={join}>
          {busy ? "Opening the silo" : "Continue"}
        </button>
      </div>
    </div>
  );
}
