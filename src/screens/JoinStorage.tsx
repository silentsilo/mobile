import { api, type JoinPreview, type StoreConfigInput } from "../api";
import { StepBar } from "../ui/chrome";
import { StorageForm } from "../ui/StorageForm";
import { t, useLocale } from "../i18n";

export function JoinStorage({
  onBack,
  onFound,
}: {
  onBack: () => void;
  onFound: (config: StoreConfigInput, preview: JoinPreview) => void;
}) {
  useLocale();
  const look = async (config: StoreConfigInput) => {
    const preview = await api.previewJoin(config);
    if (!preview.vault_id) {
      throw t("silo.join_not_found");
    }
    onFound(config, preview);
  };

  return (
    <div className="screen">
      <StepBar step={1} of={3} onBack={onBack} />
      <div className="screen-body">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 className="title">{t("silo.join_title")}</h1>
          <p className="hint">{t("silo.join_hint")}</p>
        </div>
        <StorageForm submitLabel={t("silo.continue")} busyLabel={t("silo.join_busy")} onSubmit={look} joining />
      </div>
    </div>
  );
}
