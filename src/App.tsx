import { Folder, KeyRound, ShieldCheck } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { api, type DeviceCheck as Check, type JoinPreview, type Offered, type StoreConfigInput, type SyncStatus } from "./api";
import { blockingFailures, DeviceCheck } from "./screens/DeviceCheck";
import { Entry } from "./screens/Entry";
import { EntryEdit } from "./screens/EntryEdit";
import { Files } from "./screens/Files";
import { JoinCode } from "./screens/JoinCode";
import { JoinKey } from "./screens/JoinKey";
import { JoinStorage } from "./screens/JoinStorage";
import { Keys } from "./screens/Keys";
import { Passwords } from "./screens/Passwords";
import { PhoneBackup } from "./screens/PhoneBackup";
import { Preview } from "./screens/Preview";
import { SaveShared } from "./screens/SaveShared";
import { Health } from "./screens/Health";
import { Trash } from "./screens/Trash";
import { Silo } from "./screens/Silo";
import { Unlock } from "./screens/Unlock";
import { Welcome } from "./screens/Welcome";
import { formatAppError } from "./shared/errors";
import type { Bootstrap, FileEntry, PasswordEntry } from "./shared/types";
import { ToastProvider, useToast } from "./ui/chrome";
import { SyncActivityProvider } from "./ui/syncActivity";

type Phase =
  | { at: "loading" }
  | { at: "failed"; message: string }
  | { at: "device"; check: Check; checking: boolean }
  | { at: "welcome" }
  | { at: "join-storage" }
  | { at: "join-code"; config: StoreConfigInput; preview: JoinPreview }
  | { at: "join-key" }
  | { at: "locked"; siloName: string; autoPrompt: boolean }
  | { at: "open"; siloName: string };

// Where a silo in this state belongs. A joined silo without this phone's key
// goes back to the last join step rather than to the unlock screen.
function phaseFor(boot: Bootstrap, autoPrompt = true): Phase {
  if (!boot.silo) return { at: "welcome" };
  if (!boot.platform_enrolled && !boot.locked) return { at: "join-key" };
  return boot.locked ? { at: "locked", siloName: boot.silo.name, autoPrompt } : { at: "open", siloName: boot.silo.name };
}

export default function App() {
  const [phase, setPhase] = useState<Phase>({ at: "loading" });
  // Files another app shared, waiting for the silo to be open.
  const [shared, setShared] = useState<Offered[]>([]);

  const takeShared = useCallback(() => {
    api.takeShared().then((files) => files.length && setShared(files), () => {});
  }, []);

  useEffect(() => {
    takeShared();
    const onVisible = () => document.visibilityState === "visible" && takeShared();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [takeShared]);

  const refresh = useCallback(async (autoPrompt = true) => {
    try {
      setPhase(phaseFor(await api.bootstrap(), autoPrompt));
    } catch (e) {
      setPhase({ at: "failed", message: formatAppError(e) });
    }
  }, []);

  // Before anything else: a phone that cannot hold a silo key should say so
  // here, not halfway through setting one up.
  const start = useCallback(async () => {
    try {
      const check = await api.deviceCheck();
      if (blockingFailures(check)) {
        setPhase({ at: "device", check, checking: false });
        return;
      }
      await refresh();
    } catch (e) {
      setPhase({ at: "failed", message: formatAppError(e) });
    }
  }, [refresh]);

  useEffect(() => {
    void start();
  }, [start]);

  // The header's silo switcher: another silo in front, or joining a new one.
  useEffect(() => {
    const onChoice = (event: Event) => {
      if ((event as CustomEvent).detail === "add") setPhase({ at: "join-storage" });
      else void refresh();
    };
    window.addEventListener("silo-choice", onChoice);
    return () => window.removeEventListener("silo-choice", onChoice);
  }, [refresh]);

  // The phone locks an open silo itself once the app has been away too long.
  // The event can be lost while the page is paused, so coming back to the
  // screen asks again.
  const open = phase.at === "open";
  useEffect(() => {
    if (!open) return;
    const recheck = () => void refresh();
    const onVisible = () => document.visibilityState === "visible" && recheck();
    const unlisten = listen("silos-locked", recheck);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void unlisten.then((stop) => stop());
    };
  }, [open, refresh]);

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
      case "device":
        return (
          <DeviceCheck
            check={phase.check}
            checking={phase.checking}
            onRetry={() => {
              setPhase({ ...phase, checking: true });
              void start();
            }}
          />
        );
      case "welcome":
        return <Welcome onStart={() => setPhase({ at: "join-storage" })} />;
      case "join-storage":
        return <JoinStorage onBack={() => void refresh()} onFound={(config, preview) => setPhase({ at: "join-code", config, preview })} />;
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
        return (
          <Unlock
            key={String(phase.autoPrompt)}
            siloName={phase.siloName}
            autoPrompt={phase.autoPrompt}
            shared={shared}
            onSentShared={() => setShared([])}
            onUnlocked={() => void refresh()}
          />
        );
      case "open":
        return shared.length ? (
          <SaveShared files={shared} siloName={phase.siloName} onDone={() => setShared([])} />
        ) : (
          <OpenSilo siloName={phase.siloName} onLocked={() => void refresh(false)} />
        );
    }
  }
}

type Tab = "passwords" | "files" | "silo";

type Detail =
  | { at: "entry"; entry: PasswordEntry }
  | { at: "edit"; entry: PasswordEntry | null }
  | { at: "preview"; file: FileEntry }
  | { at: "keys" }
  | { at: "backup" }
  | { at: "trash" }
  | { at: "health" };

function OpenSilo({ siloName, onLocked }: { siloName: string; onLocked: () => void }) {
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refreshSync = useCallback(() => {
    api.syncStatus().then(setSync, () => setSync(null));
  }, []);

  useEffect(refreshSync, [refreshSync]);

  const changed = useCallback(() => {
    setReloadKey((k) => k + 1);
    refreshSync();
  }, [refreshSync]);

  return (
    <SyncActivityProvider onReport={refreshSync} onChanged={changed}>
      <OpenSiloScreens siloName={siloName} onLocked={onLocked} sync={sync} reloadKey={reloadKey} refreshSync={refreshSync} changed={changed} />
    </SyncActivityProvider>
  );
}

function OpenSiloScreens({
  siloName,
  onLocked,
  sync,
  reloadKey,
  refreshSync,
  changed,
}: {
  siloName: string;
  onLocked: () => void;
  sync: SyncStatus | null;
  reloadKey: number;
  refreshSync: () => void;
  changed: () => void;
}) {
  const [tab, setTab] = useState<Tab>("passwords");
  const [detail, setDetail] = useState<Detail | null>(null);
  const toast = useToast();

  if (detail) {
    switch (detail.at) {
      case "entry":
        return <Entry entry={detail.entry} onBack={() => setDetail(null)} onEdit={() => setDetail({ at: "edit", entry: detail.entry })} />;
      case "edit":
        return (
          <EntryEdit
            entry={detail.entry}
            onCancel={() => setDetail(detail.entry ? { at: "entry", entry: detail.entry } : null)}
            onSaved={(saved) => {
              changed();
              setDetail({ at: "entry", entry: saved });
            }}
            onDeleted={() => {
              changed();
              setDetail(null);
              toast("Entry deleted.");
            }}
          />
        );
      case "preview":
        return <Preview file={detail.file} onBack={() => setDetail(null)} />;
      case "keys":
        return <Keys onBack={() => setDetail(null)} />;
      case "backup":
        return <PhoneBackup onBack={() => setDetail(null)} />;
      case "trash":
        return <Trash onBack={() => setDetail(null)} />;
      case "health":
        return <Health onBack={() => setDetail(null)} onOpen={(entry) => setDetail({ at: "entry", entry })} />;
    }
  }

  const tabs: { id: Tab; label: string; Icon: typeof KeyRound }[] = [
    { id: "passwords", label: "Passwords", Icon: KeyRound },
    { id: "files", label: "Files", Icon: Folder },
    { id: "silo", label: "Silo", Icon: ShieldCheck },
  ];

  return (
    <div className="screen">
      {tab === "passwords" && (
        <Passwords
          siloName={siloName}
          sync={sync}
          reloadKey={reloadKey}
          onOpen={(entry) => setDetail({ at: "entry", entry })}
          onAdd={() => setDetail({ at: "edit", entry: null })}
        />
      )}
      {tab === "files" && <Files siloName={siloName} sync={sync} reloadKey={reloadKey} onOpenFile={(file) => setDetail({ at: "preview", file })} />}
      {tab === "silo" && <Silo siloName={siloName} sync={sync} onSynced={refreshSync} onKeys={() => setDetail({ at: "keys" })} onBackup={() => setDetail({ at: "backup" })} onTrash={() => setDetail({ at: "trash" })} onHealth={() => setDetail({ at: "health" })} onLocked={onLocked} />}
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
