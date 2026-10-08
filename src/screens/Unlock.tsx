import { Fingerprint, ScanFace } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Offered } from "../api";
import { formatAppError } from "../shared/errors";
import { isComplete } from "../shared/recoveryCode";
import { Notice, Sheet } from "../ui/chrome";
import { isIOS } from "../ui/platform";
import { RecoveryCodeInput } from "../ui/RecoveryCodeInput";
import { SecurityKeyWait } from "../ui/SecurityKeyWait";
import { haptic } from "../ui/haptics";
import { t, useLocale } from "../i18n";

// What unlocks the phone's key: a fingerprint on Android; Face ID or Touch ID on iOS.
const BiometricIcon = isIOS ? ScanFace : Fingerprint;

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
  useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The phone's key was retired by a fingerprint change. Nothing this screen
  // does will open the silo; the recovery code will, and the app then offers
  // to make a new key.
  const [invalidated, setInvalidated] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [code, setCode] = useState("");
  const [keyCount, setKeyCount] = useState(0);
  const [waitingForKey, setWaitingForKey] = useState(false);
  const asked = useRef(false);

  useEffect(() => {
    api.securityKeyCount().then(setKeyCount, () => setKeyCount(0));
  }, []);

  const unlockWithKey = async () => {
    setError(null);
    setWaitingForKey(true);
    try {
      await api.unlockWithSecurityKey();
      setWaitingForKey(false);
      haptic("confirm");
      onUnlocked();
    } catch (e) {
      setWaitingForKey(false);
      if (e !== "Cancelled") setError(formatAppError(e));
    }
  };

  const unlock = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.unlock();
      haptic("confirm");
      onUnlocked();
    } catch (e) {
      if (String(e).includes("[invalidated]")) setInvalidated(true);
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

  const openRecovery = () => {
    setError(null);
    setRecovering(true);
  };

  const unlockWithCode = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.unlockWithRecovery(code);
      setRecovering(false);
      haptic("confirm");
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
        <div className="hero-icon halo">
          <BiometricIcon size={64} strokeWidth={1.5} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center" }}>
          <h1 className="title headline">{t("start.locked")}</h1>
          <p className="hint">
            {invalidated
              ? t("start.unlock_hint_invalidated")
              : busy
                ? t("start.waiting_biometric")
                : t("start.unlock_hint")}
          </p>
        </div>
        {invalidated && (
          <Notice tone="warning" style={{ alignSelf: "stretch" }}>
            <p className="hint small">{t("start.unlock_invalidated_body")}</p>
          </Notice>
        )}
        {shared.length > 0 && (
          <div className="notice" style={{ alignSelf: "stretch" }}>
            {t("start.unlock_shared", { count: shared.length })}
          </div>
        )}
        {error && !recovering && !invalidated && (
          <Notice tone="error" style={{ alignSelf: "stretch" }}>
            {error}
          </Notice>
        )}
        <div style={{ flex: 1.3 }} />
        {/* One main action; the other ways in are quieter. */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, alignSelf: "stretch" }}>
          {invalidated ? (
            <button className="btn" disabled={busy} onClick={openRecovery}>
              {t("start.use_recovery_code")}
            </button>
          ) : (
            <button className="btn" aria-busy={busy && !recovering} disabled={busy} onClick={unlock}>
              {!(busy && !recovering) && <BiometricIcon size={20} aria-hidden />}
              {t("start.unlock")}
            </button>
          )}
          {keyCount > 0 && (
            <button className="text-btn" disabled={busy} onClick={() => void unlockWithKey()}>
              {t("start.use_security_key")}
            </button>
          )}
          {shared.length > 0 && (
            <button className="text-btn" disabled={busy} onClick={() => void sendShared()}>
              {t("start.send_without_unlocking")}
            </button>
          )}
          {!invalidated && (
            <button className="text-btn" disabled={busy} onClick={openRecovery}>
              {t("start.use_recovery_code")}
            </button>
          )}
        </div>
      </div>

      <Sheet open={waitingForKey} onClose={() => void api.cancelSecurityKey()} title={t("start.unlock_key_title")}>
        <SecurityKeyWait />
        <button className="btn secondary" onClick={() => void api.cancelSecurityKey()}>
          {t("common.cancel")}
        </button>
      </Sheet>

      <Sheet open={recovering} onClose={() => setRecovering(false)} title={t("start.unlock_code_title")}>
        <RecoveryCodeInput value={code} onChange={setCode} disabled={busy} autoFocus />
        {error && <Notice tone="error">{error}</Notice>}
        <button className="btn" aria-busy={busy} disabled={!isComplete(code) || busy} onClick={unlockWithCode}>
          {busy ? t("start.unlocking") : t("start.unlock")}
        </button>
      </Sheet>
    </div>
  );
}
