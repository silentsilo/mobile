import { ScanFace } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { isComplete } from "../shared/recoveryCode";
import { Sheet } from "../ui/chrome";
import { RecoveryCodeInput } from "../ui/RecoveryCodeInput";

export function Unlock({ siloName, onUnlocked }: { siloName: string; onUnlocked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [code, setCode] = useState("");
  const asked = useRef(false);

  const unlock = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.unlock();
      onUnlocked();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  }, [onUnlocked]);

  // The prompt starts by itself; the button is for after it was dismissed.
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void unlock();
  }, [unlock]);

  const unlockWithCode = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.unlockWithRecovery(code);
      setRecovering(false);
      onUnlocked();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <div className="screen-body" style={{ alignItems: "center", paddingTop: 24 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            minHeight: 44,
            padding: "0 16px",
            borderRadius: 999,
            border: "1px solid var(--border)",
            fontWeight: 650,
          }}
        >
          {siloName}
        </div>
        <div className="spacer" />
        <div
          style={{
            width: 148,
            height: 148,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(139, 92, 246, 0.08)",
            boxShadow: "0 0 0 14px rgba(139, 92, 246, 0.05)",
            border: "1px solid var(--border)",
            color: "var(--accent-hover)",
          }}
        >
          <ScanFace size={64} strokeWidth={1.5} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center" }}>
          <h1 className="title" style={{ fontSize: "1.5rem" }}>
            Locked
          </h1>
          <p className="hint">{busy ? "Waiting for your fingerprint or face" : "Unlock with your fingerprint or face"}</p>
        </div>
        {error && !recovering && (
          <div className="notice error" style={{ alignSelf: "stretch" }}>
            {error}
          </div>
        )}
        <div style={{ flex: 1.3 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 10, alignSelf: "stretch" }}>
          <button className="btn" disabled={busy} onClick={unlock}>
            Unlock
          </button>
          <button className="btn secondary" disabled={busy} onClick={() => { setError(null); setRecovering(true); }}>
            Use recovery code
          </button>
        </div>
      </div>

      <Sheet open={recovering} onClose={() => setRecovering(false)} title="Unlock with your recovery code">
        <RecoveryCodeInput value={code} onChange={setCode} disabled={busy} autoFocus />
        {error && <div className="notice error">{error}</div>}
        <button className="btn" disabled={!isComplete(code) || busy} onClick={unlockWithCode}>
          {busy ? "Unlocking" : "Unlock"}
        </button>
      </Sheet>
    </div>
  );
}
