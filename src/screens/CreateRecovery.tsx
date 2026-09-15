import { StepBar } from "../ui/chrome";
import { RecoveryCodeShow } from "../ui/RecoveryCodeShow";

export function CreateRecovery({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  return (
    <div className="screen">
      <StepBar step={2} onBack={onBack} />
      <div className="screen-body">
        <h1 className="title">Your recovery code</h1>
        <RecoveryCodeShow replacing={false} onDone={onDone} />
      </div>
    </div>
  );
}
