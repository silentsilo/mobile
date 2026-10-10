import { ScanFace } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { useBackLayer } from "../ui/back";
import { Field, Notice, StepBar, TopBar } from "../ui/chrome";
import { t, useLocale } from "../i18n";
import { isIOS } from "../ui/platform";

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
  useLocale();
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
      await api.enrollDeviceKey(label.trim() || t("start.key_default_label"));
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
          <h1 className="title">{rekey ? t("start.rekey_title") : t("start.key_title")}</h1>
          <p className="hint">{rekey ? t(isIOS ? "start.rekey_body_ios" : "start.rekey_body") : t("start.key_body")}</p>
        </div>
        <Notice tone="warning">
          <p className="hint small">{t(isIOS ? "start.key_warning_ios" : "start.key_warning")}</p>
        </Notice>
        <Field label={t("start.key_name_label")}>
          <div className="input">
            <input
              value={label}
              placeholder={t("start.key_default_label")}
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
          {busy ? t("start.waiting_biometric") : rekey ? t("start.key_create_new") : t("start.key_create")}
        </button>
        {rekey && (
          <button className="btn secondary" disabled={busy} onClick={onBack}>
            {t("start.not_now")}
          </button>
        )}
      </div>
    </div>
  );
}
