import { Nfc } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { api, type SecurityKeyStatus } from "../api";
import { Notice } from "./chrome";
import { t, useLocale } from "../i18n";
import { isIOS } from "./platform";

/** What to do with the key while the phone waits for it. */
export function SecurityKeyWait({ touches = 1 }: { touches?: 1 | 2 }) {
  useLocale();
  const [status, setStatus] = useState<SecurityKeyStatus | null>(null);
  const [second, setSecond] = useState(false);
  useEffect(() => {
    api.securityKeyStatus().then(setStatus, () => setStatus(null));
  }, []);
  // Adding a key takes two: told when the first is done.
  useEffect(() => {
    if (touches !== 2) return;
    let stop: (() => void) | undefined;
    listen<number>("security-key-step", () => setSecond(true)).then(
      (unlisten) => (stop = unlisten),
      () => undefined,
    );
    return () => stop?.();
  }, [touches]);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "8px 0", textAlign: "center" }}>
      <div className="hero-icon small key-pulse">
        <Nfc size={40} strokeWidth={1.6} />
      </div>
      {second ? (
        <p className="hint">
          <strong>{t("start.key_once_more")}</strong> {t("start.key_once_more_body")}
        </p>
      ) : (
        <p className="hint">
          {t(isIOS ? "start.key_hold_ios" : "start.key_hold")}
          {touches === 2 ? ` ${t("start.key_twice")}` : ""}
        </p>
      )}
      {status && status.nfc && !status.nfcOn && (
        <Notice tone="warning" style={{ alignSelf: "stretch" }}>
          {t(isIOS ? "start.key_nfc_off_ios" : "start.key_nfc_off")}
        </Notice>
      )}
      {status && !status.nfc && !status.usb && (
        <Notice tone="error" quiet style={{ alignSelf: "stretch" }}>
          {t("start.key_no_reader")}
        </Notice>
      )}
    </div>
  );
}
