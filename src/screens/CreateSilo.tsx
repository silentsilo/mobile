import { useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { Field, Notice, StepBar } from "../ui/chrome";
import { t, useLocale } from "../i18n";

/** A new silo, made on this phone. Its key, recovery code and storage come next. */
export function CreateSilo({ onBack, onCreated }: { onBack: () => void; onCreated: () => void }) {
  useLocale();
  const [name, setName] = useState(() => t("start.default_name"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createSilo(name.trim());
      onCreated();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <StepBar step={1} of={4} onBack={onBack} />
      <div className="screen-body">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 className="title">{t("start.create")}</h1>
          <p className="hint">{t("start.create_body")}</p>
        </div>
        <Field label={t("start.create_name_label")}>
          <div className="input">
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="spacer" />
        <button className="btn" aria-busy={busy} disabled={!name.trim() || busy} onClick={() => void create()}>
          {busy ? t("start.creating") : t("start.continue")}
        </button>
      </div>
    </div>
  );
}
