import { useState } from "react";
import { StepBar } from "../ui/chrome";
import { RecoveryCodeShow } from "../ui/RecoveryCodeShow";

/**
 * The recovery code step. Coming back to it after the code was made does not
 * make another on its own: a second code would quietly replace the one
 * already written down.
 */
export function CreateRecovery({ made, onBack, onDone }: { made: boolean; onBack: () => void; onDone: () => void }) {
  const [again, setAgain] = useState(false);
  return (
    <div className="screen">
      <StepBar step={2} onBack={onBack} />
      <div className="screen-body">
        <h1 className="title">Your recovery code</h1>
        {made && !again ? (
          <>
            <p className="hint">The recovery code is made. Keep the paper you wrote it on.</p>
            <button className="btn" onClick={onDone}>
              Continue
            </button>
            <button className="btn secondary" onClick={() => setAgain(true)}>
              Make a new code
            </button>
          </>
        ) : (
          <RecoveryCodeShow replacing={made} onDone={onDone} />
        )}
      </div>
    </div>
  );
}
