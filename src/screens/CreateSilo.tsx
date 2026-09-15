import { useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { Field, StepBar } from "../ui/chrome";

/** A new silo, made on this phone. Its key, recovery code and storage come next. */
export function CreateSilo({ onBack, onCreated }: { onBack: () => void; onCreated: () => void }) {
  const [name, setName] = useState("Personal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createSilo(name.trim());
      onCreated();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <StepBar step={1} onBack={onBack} />
      <div className="screen-body">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 className="title">Make a new silo</h1>
          <p className="hint">
            Passwords and files, encrypted on this phone before they go anywhere. Next come this phone's key, a recovery code
            and the storage it backs up to.
          </p>
        </div>
        <Field label="Name">
          <div className="input">
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
        </Field>
        {error && <div className="notice error">{error}</div>}
        <div className="spacer" />
        <button className="btn" disabled={!name.trim() || busy} onClick={() => void create()}>
          {busy ? "Making the silo" : "Continue"}
        </button>
      </div>
    </div>
  );
}
