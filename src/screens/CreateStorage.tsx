import { useState } from "react";
import { api, type StoreConfigInput } from "../api";
import { Sheet, StepBar } from "../ui/chrome";
import { StorageForm } from "../ui/StorageForm";
import { t, useLocale } from "../i18n";

/** Where a silo made on this phone backs up, and its first sync. */
export function CreateStorage({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  useLocale();
  const [later, setLater] = useState(false);

  const save = async (config: StoreConfigInput) => {
    await api.saveStorage(config);
    await api.syncNow().catch(() => undefined);
    onDone();
  };

  return (
    <div className="screen">
      <StepBar step={4} of={4} onBack={onBack} />
      <div className="screen-body">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 className="title">{t("silo.create_title")}</h1>
          <p className="hint">{t("silo.create_hint")}</p>
        </div>
        <StorageForm submitLabel={t("silo.create_submit")} busyLabel={t("silo.checking_storage")} onSubmit={save} />
        <button className="text-btn" style={{ alignSelf: "center" }} onClick={() => setLater(true)}>
          {t("silo.set_up_later")}
        </button>
      </div>

      <Sheet open={later} onClose={() => setLater(false)} title={t("silo.later_title")}>
        <p className="hint">{t("silo.later_hint")}</p>
        <button className="btn" onClick={() => setLater(false)}>
          {t("silo.later_now")}
        </button>
        <button className="btn secondary" onClick={onDone}>
          {t("silo.later_skip")}
        </button>
      </Sheet>
    </div>
  );
}
