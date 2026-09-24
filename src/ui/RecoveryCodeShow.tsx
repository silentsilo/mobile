import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { toGroups } from "../shared/recoveryCode";

type Keeper = { showing: (code: string) => void; hidden: () => void; kept: () => void };

const CodeKeeper = createContext<Keeper | null>(null);

/**
 * Holds a new recovery code until it is written down. The code made before
 * stops working as soon as this one exists, and the silo can lock while the
 * code is on screen (the screen turning off does it), which took the sheet
 * showing it away. The code then comes back on its own screen, in front of
 * whatever is up, until the person says it is kept.
 */
export function RecoveryCodeKeeper({ children }: { children: ReactNode }) {
  const [held, setHeld] = useState<{ code: string; onScreen: boolean } | null>(null);
  const keeper = useMemo<Keeper>(
    () => ({
      showing: (code) => setHeld({ code, onScreen: true }),
      hidden: () => setHeld((h) => (h ? { ...h, onScreen: false } : h)),
      kept: () => setHeld(null),
    }),
    [],
  );
  return (
    <CodeKeeper.Provider value={keeper}>
      {held && !held.onScreen ? (
        <div className="screen">
          <div className="screen-body">
            <h1 className="title">Your new recovery code</h1>
            <p className="hint">
              The silo locked while this code was on screen. Write it down now: it is not shown again, and the code made
              before stops working.
            </p>
            <CodeOnPaper code={held.code} onKept={keeper.kept} />
          </div>
        </div>
      ) : (
        children
      )}
    </CodeKeeper.Provider>
  );
}

/** The code in its printed groups, and the promise it was written down. */
function CodeOnPaper({ code, onKept }: { code: string; onKept: () => void }) {
  const [kept, setKept] = useState(false);
  return (
    <>
      <div className="panel mono" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, padding: 16, fontSize: "1.2rem", textAlign: "center" }}>
        {toGroups(code).map((group, i) => (
          <span key={i}>{group}</span>
        ))}
      </div>
      <p className="hint small">There is no copy button: other apps can read the clipboard.</p>
      <label className="row" style={{ minHeight: 56, gap: 12 }}>
        <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} style={{ width: 22, height: 22 }} />
        <span style={{ fontSize: "0.95rem" }}>I wrote the code down and keep it apart from this phone</span>
      </label>
      <button className="btn" disabled={!kept} onClick={onKept}>
        Continue
      </button>
    </>
  );
}

/**
 * Makes the silo's recovery code and shows it, once. `replacing` warns that
 * the old code stops working. Done only after the person says it is kept.
 */
export function RecoveryCodeShow({
  replacing,
  archiveTargets = 0,
  onShown,
  onDone,
}: {
  replacing: boolean;
  /** Never-delete copies, which keep the old code. */
  archiveTargets?: number;
  /** The code exists from here on, whether or not it gets written down. */
  onShown?: () => void;
  onDone: () => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keeper = useContext(CodeKeeper);

  // Held above this screen while it is up, so a lock does not lose it.
  useEffect(() => {
    if (!code) return;
    keeper?.showing(code);
    return () => keeper?.hidden();
  }, [code, keeper]);

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      setCode(await api.createRecovery());
      onShown?.();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!code) {
    return (
      <>
        <p className="hint">
          The recovery code opens the silo when every key is gone, after a lost phone or a changed fingerprint. It is shown
          once, so write it on paper.
        </p>
        {replacing && (
          <div className="notice warning">
            The code made before stops working once this one syncs. Throw the old paper away after.
            {archiveTargets > 0 && " A never-delete copy keeps the old code, and it still opens what is stored there."}
          </div>
        )}
        {error && <div className="notice error">{error}</div>}
        <button className="btn" disabled={busy} onClick={() => void make()}>
          {busy ? "Making the code" : replacing ? "Make a new code" : "Make the recovery code"}
        </button>
      </>
    );
  }

  return (
    <CodeOnPaper
      code={code}
      onKept={() => {
        keeper?.kept();
        onDone();
      }}
    />
  );
}
