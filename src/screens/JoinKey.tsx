import { LockKeyhole, ScanFace } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { Field, StepBar } from "../ui/chrome";

export function JoinKey({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [label, setLabel] = useState("");
  const [edited, setEdited] = useState(false);

  // The phone's own name, unless the user already typed one.
  useEffect(() => {
    api.deviceName().then(
      (name) => !edited && name && setLabel(name),
      () => {},
    );
  }, [edited]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.enrollDeviceKey(label.trim() || "This phone");
      onDone();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <StepBar step={3} onBack={onBack} />
      <div className="screen-body">
        <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
          <div
            style={{
              width: 112,
              height: 112,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(139, 92, 246, 0.1)",
              border: "1px solid var(--border)",
              color: "var(--accent-hover)",
            }}
          >
            <ScanFace size={52} strokeWidth={1.6} />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 className="title">Let this phone unlock the silo</h1>
          <p className="hint">
            SilentSilo makes a key inside this phone's secure hardware. The key never leaves the phone and opens the silo
            only after your fingerprint or face.
          </p>
        </div>
        <div className="notice warning">
          <LockKeyhole size={20} style={{ flex: "none", marginTop: 1 }} />
          <p className="hint" style={{ fontSize: "0.88rem" }}>
            Adding or removing a fingerprint later retires this key. You would then unlock with your recovery code and set
            the phone up again.
          </p>
        </div>
        <Field label="Name this key">
          <div className="input">
            <input
              value={label}
              placeholder="This phone"
              onChange={(e) => {
                setEdited(true);
                setLabel(e.target.value);
              }}
            />
          </div>
        </Field>
        {error && <div className="notice error">{error}</div>}
        <div className="spacer" />
        <button className="btn" disabled={busy} onClick={create}>
          {busy ? "Waiting for your fingerprint or face" : "Create key"}
        </button>
      </div>
    </div>
  );
}
