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
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    api.securityKeyStatus().then(setStatus, () => setStatus(null));
  }, []);
  // No key after about 10 s: some phones keep the USB port shut to a key
  // until OTG is switched on.
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(timer);
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
      {slow && !second && !isIOS && status?.usb && (
        <Notice style={{ alignSelf: "stretch" }}>
          {t("start.key_usb_otg")}
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
