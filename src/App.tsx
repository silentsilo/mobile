import { Folder, KeyRound, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type JoinPreview, type StoreConfigInput, type SyncStatus } from "./api";
import { JoinCode } from "./screens/JoinCode";
import { JoinKey } from "./screens/JoinKey";
import { JoinStorage } from "./screens/JoinStorage";
import { Passwords } from "./screens/Passwords";
import { Unlock } from "./screens/Unlock";
import { Welcome } from "./screens/Welcome";
import { formatAppError } from "./shared/errors";
import type { Bootstrap, PasswordEntry } from "./shared/types";
import { ToastProvider } from "./ui/chrome";

type Phase =
  | { at: "loading" }
  | { at: "failed"; message: string }
  | { at: "welcome" }
  | { at: "join-storage" }
  | { at: "join-code"; config: StoreConfigInput; preview: JoinPreview }
  | { at: "join-key" }
  | { at: "locked"; siloName: string }
  | { at: "open"; siloName: string };

type Tab = "passwords" | "files" | "silo";

// Where a silo in this state belongs. A joined silo without this phone's key
// goes back to the last join step rather than to the unlock screen.
function phaseFor(boot: Bootstrap): Phase {
  if (!boot.silo) return { at: "welcome" };
  if (!boot.platform_enrolled && !boot.locked) return { at: "join-key" };
  return boot.locked ? { at: "locked", siloName: boot.silo.name } : { at: "open", siloName: boot.silo.name };
}

export default function App() {
  const [phase, setPhase] = useState<Phase>({ at: "loading" });

  const refresh = useCallback(async () => {
    try {
      setPhase(phaseFor(await api.bootstrap()));
    } catch (e) {
      setPhase({ at: "failed", message: formatAppError(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <ToastProvider>{render()}</ToastProvider>;

  function render() {
    switch (phase.at) {
      case "loading":
        return <div className="screen" />;
      case "failed":
        return (
          <div className="screen">
            <div className="screen-body">
              <div className="notice error">{phase.message}</div>
            </div>
          </div>
        );
      case "welcome":
        return <Welcome onStart={() => setPhase({ at: "join-storage" })} />;
      case "join-storage":
        return (
          <JoinStorage
            onBack={() => setPhase({ at: "welcome" })}
            onFound={(config, preview) => setPhase({ at: "join-code", config, preview })}
          />
        );
      case "join-code":
        return (
          <JoinCode
            config={phase.config}
            preview={phase.preview}
            onBack={() => setPhase({ at: "join-storage" })}
            onJoined={() => setPhase({ at: "join-key" })}
          />
        );
      case "join-key":
        return <JoinKey onBack={() => void refresh()} onDone={() => void refresh()} />;
      case "locked":
        return <Unlock siloName={phase.siloName} onUnlocked={() => void refresh()} />;
      case "open":
        return <OpenSilo siloName={phase.siloName} />;
    }
  }
}

function OpenSilo({ siloName }: { siloName: string }) {
  const [tab, setTab] = useState<Tab>("passwords");
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [, setOpened] = useState<PasswordEntry | null>(null);

  useEffect(() => {
    api.syncStatus().then(setSync, () => setSync(null));
  }, []);

  const tabs: { id: Tab; label: string; Icon: typeof KeyRound }[] = [
    { id: "passwords", label: "Passwords", Icon: KeyRound },
    { id: "files", label: "Files", Icon: Folder },
    { id: "silo", label: "Silo", Icon: ShieldCheck },
  ];

  return (
    <div className="screen">
      {tab === "passwords" && <Passwords siloName={siloName} sync={sync} onOpen={setOpened} />}
      {tab !== "passwords" && <div style={{ flex: 1 }} />}
      <nav className="tabbar" role="tablist">
        {tabs.map(({ id, label, Icon }) => (
          <button key={id} className="tab" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            <Icon size={24} />
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
