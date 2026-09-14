import { EllipsisVertical, KeyRound, ScanFace, Smartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import type { SecurityKeyInfo } from "../shared/types";
import { Sheet, TopBar } from "../ui/chrome";

function describe(key: SecurityKeyInfo) {
  switch (key.kind ?? "fido2") {
    case "android-keystore":
      return { Icon: Smartphone, detail: "Android phone" };
    case "secure-enclave":
      return { Icon: ScanFace, detail: "Mac with Touch ID" };
    default:
      return key.platform ? { Icon: ScanFace, detail: "Computer's built-in sign-in" } : { Icon: KeyRound, detail: "Security key" };
  }
}

export function Keys({ onBack }: { onBack: () => void }) {
  const [keys, setKeys] = useState<SecurityKeyInfo[] | null>(null);
  const [chosen, setChosen] = useState<SecurityKeyInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listKeys().then(setKeys, (e) => setError(formatAppError(e)));
  }, []);

  useEffect(load, [load]);

  const remove = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await api.removeKey(chosen.credential_id);
      setChosen(null);
      load();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <TopBar onBack={onBack} backLabel="Silo" />
      <div className="screen-body tight" style={{ gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
          <h1 className="title">Keys</h1>
          <p className="hint">
            Each key opens this silo on its own. Removing one stops it opening the silo; on storage that keeps deleted files,
            finish with a key change from SilentSilo on your computer.
          </p>
        </div>
        {error && !chosen && <div className="notice error">{error}</div>}
        {keys && (
          <div className="panel">
            {keys.map((key, i) => {
              const { Icon, detail } = describe(key);
              return (
                <div key={key.credential_id} className={`row${i > 0 ? " divide" : ""}`} style={{ minHeight: 72, paddingRight: 6 }}>
                  <span className="tile">
                    <Icon size={20} />
                  </span>
                  <span className="row-text" style={{ gap: 3 }}>
                    <span className="row-title" style={{ fontSize: "0.98rem" }}>{key.label || detail}</span>
                    <span className="row-sub">{detail}</span>
                  </span>
                  <button className="icon-btn" aria-label={`Options for ${key.label || detail}`} onClick={() => { setError(null); setChosen(key); }}>
                    <EllipsisVertical size={20} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Sheet open={chosen !== null} onClose={() => setChosen(null)} title={chosen ? `Remove ${chosen.label || describe(chosen).detail}?` : undefined}>
        <p className="hint">
          It stops opening this silo. If it was lost or stolen, change the silo's key from SilentSilo on your computer as
          well, so a copy kept by the storage cannot be used.
        </p>
        {error && <div className="notice error">{error}</div>}
        <button className="btn danger" onClick={remove} disabled={busy}>
          {busy ? "Removing" : "Remove key"}
        </button>
        <button className="btn secondary" onClick={() => setChosen(null)} disabled={busy}>
          Keep it
        </button>
      </Sheet>
    </div>
  );
}
