import { Nfc } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type SecurityKeyStatus } from "../api";

/** What to do with the key while the phone waits for it. */
export function SecurityKeyWait({ touches = 1 }: { touches?: 1 | 2 }) {
  const [status, setStatus] = useState<SecurityKeyStatus | null>(null);
  useEffect(() => {
    api.securityKeyStatus().then(setStatus, () => setStatus(null));
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "8px 0", textAlign: "center" }}>
      <div
        className="key-pulse"
        style={{
          width: 88,
          height: 88,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(139, 92, 246, 0.1)",
          color: "var(--accent-hover)",
        }}
      >
        <Nfc size={40} strokeWidth={1.6} />
      </div>
      <p className="hint">
        Hold the key flat against the back of the phone until it is done, or plug it in and touch it
        {touches === 2 ? " each time it blinks (twice)" : " when it blinks"}.
      </p>
      {status && status.nfc && !status.nfcOn && (
        <div className="notice warning" style={{ alignSelf: "stretch" }}>
          NFC is off. Turn it on in the phone's settings, or plug the key in.
        </div>
      )}
      {status && !status.nfc && !status.usb && (
        <div className="notice error" style={{ alignSelf: "stretch" }}>
          This phone has neither NFC nor a USB port that can reach a security key.
        </div>
      )}
    </div>
  );
}
