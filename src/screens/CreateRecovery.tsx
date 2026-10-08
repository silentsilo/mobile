import { useState } from "react";
import { StepBar } from "../ui/chrome";
import { RecoveryCodeShow } from "../ui/RecoveryCodeShow";
import { t, useLocale } from "../i18n";

/**
 * The recovery code step. Coming back to it after the code was made does not
 * make another on its own: a second code would quietly replace the one
 * already written down.
 */
export function CreateRecovery({ made, onBack, onDone }: { made: boolean; onBack: () => void; onDone: () => void }) {
  useLocale();
  const [again, setAgain] = useState(false);
  return (
    <div className="screen">
      <StepBar step={3} of={4} onBack={onBack} />
      <div className="screen-body">
        <h1 className="title">{t("start.recovery_title")}</h1>
        {made && !again ? (
          <>
            <p className="hint">{t("start.recovery_made")}</p>
            <button className="btn" onClick={onDone}>
              {t("start.continue")}
            </button>
            <button className="btn secondary" onClick={() => setAgain(true)}>
              {t("start.recovery_make_new")}
            </button>
          </>
        ) : (
          <RecoveryCodeShow replacing={made} onDone={onDone} />
        )}
      </div>
    </div>
  );
}
