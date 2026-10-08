import { EllipsisVertical, KeyRound, ScanFace, Smartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type SyncStatus } from "../api";
import { formatAppError } from "../shared/errors";
import type { SecurityKeyInfo } from "../shared/types";
import { Field, Notice, Sheet, Skeleton, TopBar } from "../ui/chrome";
import { SecurityKeyWait } from "../ui/SecurityKeyWait";
import { haptic } from "../ui/haptics";
import { t, useLocale } from "../i18n";

function describe(key: SecurityKeyInfo) {
  switch (key.kind ?? "fido2") {
    case "android-keystore":
      return { Icon: Smartphone, detail: t("silo.key_kind_phone") };
    case "secure-enclave":
      return { Icon: ScanFace, detail: "Touch ID" };
    default:
      return key.platform
        ? { Icon: ScanFace, detail: t("silo.key_kind_builtin") }
        : { Icon: KeyRound, detail: t("silo.key_kind_security") };
  }
}

export function Keys({ sync, onBack }: { sync: SyncStatus | null; onBack: () => void }) {
  useLocale();
  const [keys, setKeys] = useState<SecurityKeyInfo[] | null>(null);
  const [chosen, setChosen] = useState<SecurityKeyInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Adding a security key: its name, then the key. A PIN, when the key has
  // one, is asked in Android's own dialog.
  const [adding, setAdding] = useState<"name" | "key" | null>(null);
  const [label, setLabel] = useState(() => t("silo.key_kind_security"));
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
      <TopBar onBack={onBack} backLabel={t("silo.tab_name")} />
      <div className="screen-body tight" style={{ gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
          <h1 className="title">{t("silo.row_keys")}</h1>
          <p className="hint">{t("silo.keys_intro")}</p>
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
                  <button className="icon-btn" aria-label={t("silo.key_options", { name: key.label || detail })} onClick={() => { setError(null); setChosen(key); }}>
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
            setLabel(t("silo.key_kind_security"));
            setAdding("name");
          }}
        >
          {t("silo.key_add")}
        </button>
      </div>

      <Sheet open={adding !== null} onClose={closeAdding} title={t("silo.key_add_title")}>
        {adding === "name" && (
          <>
            <p className="hint">{t("silo.key_add_hint")}</p>
            <Field label={t("silo.key_name_label")}>
              <div className="input">
                <input value={label} onChange={(e) => setLabel(e.target.value)} />
              </div>
            </Field>
            {addError && <Notice tone="error">{addError}</Notice>}
            <button className="btn" onClick={() => void addKey()}>
              {t("silo.continue")}
            </button>
          </>
        )}
        {adding === "key" && (
          <>
            <SecurityKeyWait touches={2} />
            <button className="btn secondary" onClick={closeAdding}>
              {t("common.cancel")}
            </button>
          </>
        )}
      </Sheet>

      <Sheet open={chosen !== null} onClose={() => setChosen(null)} title={chosen ? t("silo.key_remove_title", { name: chosen.label || describe(chosen).detail }) : undefined}>
        {chosen?.this_phone && (
          <Notice tone="error" quiet>
            {t("silo.key_remove_own")}
          </Notice>
        )}
        <p className="hint">
          {t("silo.key_remove_stops")}
          {(sync?.archive_targets ?? 0) > 0 && ` ${t("silo.key_remove_archive")}`} {t("silo.key_remove_lost")}
        </p>
        {error && <Notice tone="error">{error}</Notice>}
        <button className="btn danger" aria-busy={busy} onClick={remove} disabled={busy}>
          {busy ? t("silo.key_removing") : t("silo.key_remove")}
        </button>
        <button className="btn secondary" onClick={() => setChosen(null)} disabled={busy}>
          {t("common.cancel")}
        </button>
      </Sheet>
    </div>
  );
}
