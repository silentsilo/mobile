import { Nfc } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { api, type SecurityKeyStatus } from "../api";

/** What to do with the key while the phone waits for it. */
export function SecurityKeyWait({ touches = 1 }: { touches?: 1 | 2 }) {
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
      {second ? (
        <p className="hint">
          <strong>Once more.</strong> Take the key away and hold it to the phone again, or touch it again if it is plugged in.
        </p>
      ) : (
        <p className="hint">
          Hold the key flat against the back of the phone until it is done, or plug it in and touch it when it blinks.
          {touches === 2 ? " Adding a key takes this twice." : ""}
        </p>
      )}
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
