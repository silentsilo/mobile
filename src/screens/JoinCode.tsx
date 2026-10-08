import { ClipboardPaste } from "lucide-react";
import { useState } from "react";
import { api, type JoinPreview, type StoreConfigInput } from "../api";
import { formatAppError } from "../shared/errors";
import { isComplete } from "../shared/recoveryCode";
import { Field, Notice, Sheet, StepBar, useToast } from "../ui/chrome";
import { RecoveryCodeInput } from "../ui/RecoveryCodeInput";
import { SecurityKeyWait } from "../ui/SecurityKeyWait";
import { t, useLocale } from "../i18n";

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
  useLocale();
  const [code, setCode] = useState("");
  const [name, setName] = useState(() => t("start.default_name"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitingForKey, setWaitingForKey] = useState(false);
  const toast = useToast();

  // For someone with one of the silo's security keys and no code at hand.
  const joinWithKey = async () => {
    setError(null);
    setWaitingForKey(true);
    try {
      await api.joinWithSecurityKey(config, name.trim() || t("start.default_name"));
      setWaitingForKey(false);
      onJoined();
    } catch (e) {
      setWaitingForKey(false);
      if (e !== "Cancelled") setError(formatAppError(e));
    }
  };

  const paste = async () => {
    try {
      setCode(await navigator.clipboard.readText());
    } catch {
      toast(t("start.paste_failed"));
    }
  };

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.joinWithRecovery(config, code, name.trim() || t("start.default_name"));
      onJoined();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <StepBar step={2} of={3} onBack={onBack} />
      <div className="screen-body" style={{ gap: 22 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 className="title">{t("start.join_code_title")}</h1>
          <p className="hint">{t("start.join_code_body")}</p>
          {preview.key_labels.length > 0 && (
            <p className="hint small">{t("start.join_code_keys", { keys: preview.key_labels.join(", ") })}</p>
          )}
        </div>
        <RecoveryCodeInput value={code} onChange={setCode} disabled={busy} autoFocus />
        <button className="btn secondary" onClick={paste} disabled={busy}>
          <ClipboardPaste size={20} />
          {t("start.paste")}
        </button>
        <Field label={t("start.join_name_label")}>
          <div className="input">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="spacer" />
        <button className="btn" aria-busy={busy} disabled={!isComplete(code) || busy} onClick={join}>
          {busy ? t("start.joining") : t("start.continue")}
        </button>
        {preview.key_labels.length > 0 && (
          <button className="btn secondary" disabled={busy} onClick={() => void joinWithKey()}>
            {t("start.join_with_key")}
          </button>
        )}
      </div>

      <Sheet open={waitingForKey} onClose={() => void api.cancelSecurityKey()} title={t("start.join_key_title")}>
        <SecurityKeyWait />
        <button className="btn secondary" onClick={() => void api.cancelSecurityKey()}>
          {t("common.cancel")}
        </button>
      </Sheet>
    </div>
  );
}
