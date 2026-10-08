import { EllipsisVertical, KeyRound, ScanFace, Smartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type SyncStatus } from "../api";
import { formatAppError } from "../shared/errors";
import type { SecurityKeyInfo } from "../shared/types";
import { Field, Notice, Sheet, Skeleton, TopBar } from "../ui/chrome";
import { SecurityKeyWait } from "../ui/SecurityKeyWait";
import { haptic } from "../ui/haptics";

function describe(key: SecurityKeyInfo) {
  switch (key.kind ?? "fido2") {
    case "android-keystore":
      return { Icon: Smartphone, detail: "Android phone" };
    case "secure-enclave":
      return { Icon: ScanFace, detail: "Touch ID" };
    default:
      return key.platform ? { Icon: ScanFace, detail: "Windows Hello or Touch ID" } : { Icon: KeyRound, detail: "Security key" };
  }
}

export function Keys({ sync, onBack }: { sync: SyncStatus | null; onBack: () => void }) {
  const [keys, setKeys] = useState<SecurityKeyInfo[] | null>(null);
  const [chosen, setChosen] = useState<SecurityKeyInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Adding a security key: its name, then the key. A PIN, when the key has
  // one, is asked in Android's own dialog.
  const [adding, setAdding] = useState<"name" | "key" | null>(null);
  const [label, setLabel] = useState("Security key");
  const [addError, setAddError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listKeys().then(setKeys, (e) => setError(formatAppError(e)));
  }, []);

  useEffect(load, [load]);

  const remove = async () => {
    haptic("heavy");
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

  const addKey = async () => {
    setAddError(null);
    setAdding("key");
    try {
      await api.enrollSecurityKey(label);
      setAdding(null);
      load();
    } catch (e) {
      if (e === "Cancelled") {
        setAdding(null);
      } else {
        setAddError(formatAppError(e));
        setAdding("name");
      }
    }
  };

  const closeAdding = () => {
    if (adding === "key") void api.cancelSecurityKey();
    else setAdding(null);
  };

  return (
    <div className="screen">
      <TopBar onBack={onBack} backLabel="Silo" />
      <div className="screen-body tight" style={{ gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
          <h1 className="title">Keys</h1>
          <p className="hint">Each key opens this silo on its own.</p>
        </div>
        {error && !chosen && <Notice tone="error">{error}</Notice>}
        {!keys && !error && <Skeleton rows={2} />}
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
                    <span className="row-title">{key.label || detail}</span>
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
        <button
          className="btn secondary"
          onClick={() => {
            setAddError(null);
            setLabel("Security key");
            setAdding("name");
          }}
        >
          Add security key
        </button>
      </div>

      <Sheet open={adding !== null} onClose={closeAdding} title="Add a security key">
        {adding === "name" && (
          <>
            <p className="hint">
              A YubiKey or another security key with NFC or USB-C. It opens this silo here and on your computers. Keep it
              apart from the phone.
            </p>
            <Field label="Name this key">
              <div className="input">
                <input value={label} onChange={(e) => setLabel(e.target.value)} />
              </div>
            </Field>
            {addError && <Notice tone="error">{addError}</Notice>}
            <button className="btn" onClick={() => void addKey()}>
              Continue
            </button>
          </>
        )}
        {adding === "key" && (
          <>
            <SecurityKeyWait touches={2} />
            <button className="btn secondary" onClick={closeAdding}>
              Cancel
            </button>
          </>
        )}
      </Sheet>

      <Sheet open={chosen !== null} onClose={() => setChosen(null)} title={chosen ? `Remove ${chosen.label || describe(chosen).detail}?` : undefined}>
        {chosen?.this_phone && (
          <Notice tone="error" quiet>
            This is this phone&apos;s own key. Once it is removed, this phone opens the silo only with the recovery code or
            another key, and asks you to add a key again.
          </Notice>
        )}
        <p className="hint">
          It stops opening this silo.
          {(sync?.archive_targets ?? 0) > 0 && " A never-delete copy keeps the old key, and it still opens what is stored there."}{" "}
          If the key was lost or stolen, also replace the encryption key from SilentSilo on your computer, so it cannot open
          anything saved from then on.
        </p>
        {error && <Notice tone="error">{error}</Notice>}
        <button className="btn danger" onClick={remove} disabled={busy}>
          {busy ? "Removing" : "Remove key"}
        </button>
        <button className="btn secondary" onClick={() => setChosen(null)} disabled={busy}>
          Cancel
        </button>
      </Sheet>
    </div>
  );
}
