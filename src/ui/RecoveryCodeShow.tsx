import { Copy } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { toGroups } from "../shared/recoveryCode";
import { useToast } from "./chrome";

/**
 * Makes the silo's recovery code and shows it, once. `replacing` warns that
 * the old code stops working. Done only after the person says it is kept.
 */
export function RecoveryCodeShow({
  replacing,
  onShown,
  onDone,
}: {
  replacing: boolean;
  /** The code exists from here on, whether or not it gets written down. */
  onShown?: () => void;
  onDone: () => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      setCode(await api.createRecovery());
      onShown?.();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!code) {
    return (
      <>
        <p className="hint">
          The recovery code opens the silo when every key is gone: a lost phone, a changed fingerprint. It is shown once
          and not kept anywhere it could be read back, so write it on paper.
        </p>
        {replacing && (
          <div className="notice warning">The code made before stops working once this one syncs. Throw the old paper away after.</div>
        )}
        {error && <div className="notice error">{error}</div>}
        <button className="btn" disabled={busy} onClick={() => void make()}>
          {busy ? "Making the code" : replacing ? "Make a new code" : "Make the recovery code"}
        </button>
      </>
    );
  }

  return (
    <>
      <div className="panel mono" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, padding: 16, fontSize: "1.2rem", textAlign: "center" }}>
        {toGroups(code).map((group, i) => (
          <span key={i}>{group}</span>
        ))}
      </div>
      <button
        className="btn secondary"
        onClick={() => api.copySecret(code).then(() => toast("Copied. The clipboard clears itself in a minute."), (e) => toast(formatAppError(e)))}
      >
        <Copy size={18} />
        Copy
      </button>
      <label className="row" style={{ minHeight: 56, gap: 12 }}>
        <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} style={{ width: 22, height: 22 }} />
        <span style={{ fontSize: "0.95rem" }}>I wrote the code down and keep it apart from this phone</span>
      </label>
      <button className="btn" disabled={!kept} onClick={onDone}>
        Continue
      </button>
    </>
  );
}
