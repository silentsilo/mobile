import { ScanFace } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { useBackLayer } from "../ui/back";
import { Field, Notice, StepBar, TopBar } from "../ui/chrome";

/**
 * Making this phone's key. `rekey` is the same thing after a fingerprint
 * change retired the old one: the silo is already open, through the
 * recovery code, and a new key brings back unlocking, autofill and passkeys.
 */
export function JoinKey({
  onBack,
  onDone,
  step = 3,
  of = 3,
  rekey = false,
}: {
  onBack: () => void;
  onDone: () => void;
  step?: number;
  of?: number;
  rekey?: boolean;
}) {
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
  // Setting the phone up again: back is "Not now".
  useBackLayer(rekey, () => !busy && onBack());

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
      {rekey ? <TopBar /> : <StepBar step={step} of={of} onBack={onBack} />}
      <div className="screen-body">
        <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
          <div className="hero-icon">
            <ScanFace size={52} strokeWidth={1.6} />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 className="title">{rekey ? "Set this phone up again" : "Let this phone unlock the silo"}</h1>
          <p className="hint">
            {rekey
              ? "The fingerprints or faces on this phone changed, so its old key was retired. A new one brings back unlocking with your fingerprint, autofill and passkeys."
              : "SilentSilo makes a key in this phone's secure hardware, which does not let it be copied off the phone. It opens the silo after your fingerprint or face."}
          </p>
        </div>
        <Notice tone="warning">
          <p className="hint small">
            Adding or removing a fingerprint later retires this key. You would then unlock with your recovery code and set
            the phone up again.
          </p>
        </Notice>
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
        {error && <Notice tone="error">{error}</Notice>}
        <div className="spacer" />
        <button className="btn" aria-busy={busy} disabled={busy} onClick={create}>
          {busy ? "Waiting for your fingerprint or face" : rekey ? "Create new key" : "Create key"}
        </button>
        {rekey && (
          <button className="btn secondary" disabled={busy} onClick={onBack}>
            Not now
          </button>
        )}
      </div>
    </div>
  );
}
