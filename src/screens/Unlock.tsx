import { ScanFace } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, PIN_REQUIRED, type Offered } from "../api";
import { formatAppError } from "../shared/errors";
import { isComplete } from "../shared/recoveryCode";
import { Field, Sheet } from "../ui/chrome";
import { RecoveryCodeInput } from "../ui/RecoveryCodeInput";
import { SecurityKeyWait } from "../ui/SecurityKeyWait";

export function Unlock({
  siloName,
  autoPrompt,
  shared = [],
  onSentShared,
  onUnlocked,
}: {
  siloName: string;
  autoPrompt: boolean;
  shared?: Offered[];
  onSentShared?: () => void;
  onUnlocked: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [code, setCode] = useState("");
  const [keyCount, setKeyCount] = useState(0);
  const [pinFirst, setPinFirst] = useState(false);
  const [waitingForKey, setWaitingForKey] = useState(false);
  // Asked only when the key's secret without its PIN did not open the silo.
  const [askingPin, setAskingPin] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const asked = useRef(false);

  useEffect(() => {
    api.securityKeyOffer().then(
      (offer) => {
        setKeyCount(offer.count);
        setPinFirst(offer.pinFirst);
      },
      () => setKeyCount(0),
    );
  }, []);

  const unlockWithKey = async (withPin: string | null = null) => {
    setError(null);
    setPinError(null);
    setAskingPin(false);
    setWaitingForKey(true);
    try {
      await api.unlockWithSecurityKey(withPin);
      setWaitingForKey(false);
      setPin("");
      onUnlocked();
    } catch (e) {
      setWaitingForKey(false);
      if (e === PIN_REQUIRED || (typeof e === "string" && e.startsWith("Wrong PIN"))) {
        setPinError(e === PIN_REQUIRED ? null : e);
        setAskingPin(true);
      } else if (e !== "Cancelled") {
        setError(formatAppError(e));
      }
    }
  };

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

  // The prompt starts by itself, except right after "Lock now": someone who
  // just locked the silo does not want it asking to be opened again.
  useEffect(() => {
    if (asked.current || !autoPrompt) return;
    asked.current = true;
    void unlock();
  }, [unlock, autoPrompt]);

  // Shared files can go to the inbox without opening the silo, when this
  // phone is set up to send.
  const sendShared = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const file of shared) await api.shareToInbox(file);
      onSentShared?.();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

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
        {shared.length > 0 && (
          <div className="notice" style={{ alignSelf: "stretch" }}>
            Unlock to choose where {shared.length === 1 ? "the shared file goes" : `the ${shared.length} shared files go`}, or send{" "}
            {shared.length === 1 ? "it" : "them"} to Phone backup without unlocking.
          </div>
        )}
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
          {keyCount > 0 && (
            <button
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                if (pinFirst) {
                  setPinError(null);
                  setAskingPin(true);
                } else {
                  void unlockWithKey();
                }
              }}
            >
              Use security key
            </button>
          )}
          {shared.length > 0 && (
            <button className="btn secondary" disabled={busy} onClick={() => void sendShared()}>
              Send without unlocking
            </button>
          )}
          <button className="btn secondary" disabled={busy} onClick={() => { setError(null); setRecovering(true); }}>
            Use recovery code
          </button>
        </div>
      </div>

      <Sheet open={waitingForKey} onClose={() => void api.cancelSecurityKey()} title="Unlock with your security key">
        <SecurityKeyWait />
        <button className="btn secondary" onClick={() => void api.cancelSecurityKey()}>
          Cancel
        </button>
      </Sheet>

      <Sheet open={askingPin} onClose={() => setAskingPin(false)} title="Security key PIN">
        <p className="hint">A security key with a PIN needs it to open the silo, as on your computer. It is sent to the key only, and not kept.</p>
        <Field label="PIN">
          <div className="input">
            <input type="password" inputMode="numeric" autoComplete="off" value={pin} autoFocus onChange={(e) => setPin(e.target.value)} />
          </div>
        </Field>
        {pinError && <div className="notice error">{pinError}</div>}
        <button className="btn" disabled={pin.length < 4} onClick={() => void unlockWithKey(pin)}>
          Continue
        </button>
        <button className="btn secondary" onClick={() => void unlockWithKey(null)}>
          This key has no PIN
        </button>
      </Sheet>

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
