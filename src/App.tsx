import { Folder, KeyRound, ShieldCheck } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, type DeviceCheck as Check, type JoinPreview, type Offered, type StoreConfigInput, type SyncStatus } from "./api";
import { blockingFailures, DeviceCheck } from "./screens/DeviceCheck";
import { Entry } from "./screens/Entry";
import { EntryEdit } from "./screens/EntryEdit";
import { Files } from "./screens/Files";
import { CreateRecovery } from "./screens/CreateRecovery";
import { CreateSilo } from "./screens/CreateSilo";
import { CreateStorage } from "./screens/CreateStorage";
import { JoinCode } from "./screens/JoinCode";
import { Storage } from "./screens/Storage";
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
import { t, useLocale } from "./i18n";
import type { Bootstrap, FileEntry, PasswordEntry } from "./shared/types";
import icon from "./assets/icon.svg";
import { EmptyState, Notice, ToastProvider, useToast } from "./ui/chrome";
import { RecoveryCodeKeeper } from "./ui/RecoveryCodeShow";
import { SyncActivityProvider, useLeftOut } from "./ui/syncActivity";
import { useBackLayer } from "./ui/back";
import { forgetVerified } from "./ui/reverify";
import { useWide } from "./ui/useWide";

type Phase =
  | { at: "loading" }
  | { at: "failed"; message: string }
  | { at: "device"; check: Check; checking: boolean; hasSilo: boolean }
  | { at: "welcome" }
  | { at: "join-storage" }
  | { at: "join-code"; config: StoreConfigInput; preview: JoinPreview }
  | { at: "join-key" }
  | { at: "create-name" }
  | { at: "create-key" }
  | { at: "create-recovery"; made: boolean }
  | { at: "create-storage" }
  | { at: "locked"; siloName: string; autoPrompt: boolean }
  | { at: "rekey" }
  | { at: "open"; siloId: string; siloName: string };

// Where a silo in this state belongs. A joined silo without this phone's key
// goes back to the last join step rather than to the unlock screen.
function phaseFor(boot: Bootstrap, autoPrompt = true): Phase {
  if (!boot.silo) return { at: "welcome" };
  if (!boot.platform_enrolled && !boot.locked) return { at: "join-key" };
  return boot.locked
    ? { at: "locked", siloName: boot.silo.name, autoPrompt }
    : { at: "open", siloId: boot.silo.id, siloName: boot.silo.name };
}

export default function App() {
  useLocale();
  const [phase, setPhase] = useState<Phase>({ at: "loading" });
  // Files another app shared, waiting for the silo to be open.
  const [shared, setShared] = useState<Offered[]>([]);
  // The offer to make a new phone key is made once per run of the app: a
  // "Not now" means not now, and an enrolment that did not take should not
  // put the same screen back.
  const rekeyAsked = useRef(false);

  const takeShared = useCallback(() => {
    // Added to what is waiting, each once: iOS offers again what was taken
    // and not imported yet.
    api.takeShared().then(
      (files) =>
        files.length &&
        setShared((waiting) => [...waiting, ...files.filter((f) => !waiting.some((w) => w.uri === f.uri))]),
      () => {},
    );
  }, []);

  useEffect(() => {
    takeShared();
    const onVisible = () => document.visibilityState === "visible" && takeShared();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [takeShared]);

  const refresh = useCallback(async (autoPrompt = true) => {
    try {
      const boot = await api.bootstrap();
      // A silo made here and left before its first key has nothing else to
      // open it with: its making goes on from the key.
      if (boot.silo && boot.keyless) {
        if (boot.locked) await api.resumeNewSilo();
        setPhase({ at: "create-key" });
        return;
      }
      // A key the silo lists but the phone can no longer use: the fingerprints
      // changed under it. The silo is open, so this is the moment to offer a
      // new one, and autofill and passkeys start answering again with it.
      if (!boot.locked && boot.platform_enrolled && !rekeyAsked.current) {
        const key = await api.phoneKeyState().catch(() => null);
        if (key?.enrolled && !key.usable) {
          rekeyAsked.current = true;
          setPhase({ at: "rekey" });
          return;
        }
      }
      setPhase(phaseFor(boot, autoPrompt));
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
        // A phone whose fingerprints or lock were removed still holds its
        // silos: the recovery code opens them, so the check must not stand
        // in the way of that.
        const boot = await api.bootstrap().catch(() => null);
        setPhase({ at: "device", check, checking: false, hasSilo: Boolean(boot?.silo) });
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
      const detail = (event as CustomEvent).detail;
      if (detail === "add") setPhase({ at: "join-storage" });
      else if (detail === "create") setPhase({ at: "create-name" });
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
    // An organisation's silo whose activity log could not be written locks
    // itself; the action that tried says why.
    const unlistenAudit = listen("silo-audit-locked", recheck);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void unlisten.then((stop) => stop());
      void unlistenAudit.then((stop) => stop());
    };
  }, [open, refresh]);

  return (
    <ToastProvider>
      <RecoveryCodeKeeper open={open}>{render()}</RecoveryCodeKeeper>
    </ToastProvider>
  );

  function render() {
    switch (phase.at) {
      case "loading":
        return <Starting />;
      case "failed":
        return (
          <div className="screen">
            <div className="screen-body">
              <Notice tone="error">{phase.message}</Notice>
              <div className="spacer" />
              <button
                className="btn"
                onClick={() => {
                  setPhase({ at: "loading" });
                  void start();
                }}
              >
                {t("start.try_again")}
              </button>
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
            onContinue={phase.hasSilo ? () => void refresh(false) : undefined}
          />
        );
      case "welcome":
        return <Welcome onStart={() => setPhase({ at: "join-storage" })} onCreate={() => setPhase({ at: "create-name" })} />;
      case "create-name":
        return <CreateSilo onBack={() => void refresh()} onCreated={() => setPhase({ at: "create-key" })} />;
      case "create-key":
        return <JoinKey step={2} of={4} onBack={() => void refresh()} onDone={() => setPhase({ at: "create-recovery", made: false })} />;
      case "create-recovery":
        return (
          <CreateRecovery
            made={phase.made}
            onBack={() => void refresh()}
            onDone={() => setPhase({ at: "create-storage" })}
          />
        );
      case "create-storage":
        return <CreateStorage onBack={() => setPhase({ at: "create-recovery", made: true })} onDone={() => void refresh()} />;
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
      case "rekey":
        return <JoinKey rekey onBack={() => void refresh()} onDone={() => void refresh()} />;
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
          // Keyed by the silo: switching to another one starts its screens
          // fresh, instead of showing the last silo's keys and settings.
          <OpenSilo
            key={phase.siloId}
            siloId={phase.siloId}
            siloName={phase.siloName}
            onLocked={() => {
              // A lock ends every confirmation of a protected entry.
              forgetVerified();
              void refresh(false);
            }}
          />
        );
    }
  }
}

/** The app's mark while the phone is checked, after 300 ms so a quick start does not flash. */
function Starting() {
  useLocale();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), 300);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="screen" aria-busy="true">
      {shown && (
        <div className="empty-detail">
          <img src={icon} alt={t("start.starting")} width={64} height={64} style={{ borderRadius: "22%" }} />
        </div>
      )}
    </div>
  );
}

type Tab = "passwords" | "files" | "silo";

type Detail =
  | { at: "entry"; entry: PasswordEntry }
  | { at: "edit"; entry: PasswordEntry | null }
  | { at: "preview"; file: FileEntry }
  | { at: "keys" }
  | { at: "backup" }
  | { at: "trash" }
  | { at: "health" }
  | { at: "storage" };

function OpenSilo({ siloId, siloName, onLocked }: { siloId: string; siloName: string; onLocked: () => void }) {
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
    <SyncActivityProvider siloId={siloId} onReport={refreshSync} onChanged={changed}>
      <OpenSiloScreens siloId={siloId} siloName={siloName} onLocked={onLocked} sync={sync} reloadKey={reloadKey} refreshSync={refreshSync} changed={changed} />
    </SyncActivityProvider>
  );
}

function OpenSiloScreens({
  siloId,
  siloName,
  onLocked,
  sync,
  reloadKey,
  refreshSync,
  changed,
}: {
  siloId: string;
  siloName: string;
  onLocked: () => void;
  sync: SyncStatus | null;
  reloadKey: number;
  refreshSync: () => void;
  changed: () => void;
}) {
  useLocale();
  const [tab, setTab] = useState<Tab>("passwords");
  const [detail, setDetail] = useState<Detail | null>(null);
  const toast = useToast();
  const wide = useWide();
  const leftOut = useLeftOut();
  // Back from another tab goes to Passwords first, then leaves the app.
  useBackLayer(tab !== "passwords", () => setTab("passwords"));

  // Keyed by what is open, so opening another entry beside the list starts
  // its screen fresh instead of keeping the last one's state.
  const detailKey = !detail
    ? ""
    : detail.at === "entry" || detail.at === "edit"
      ? `${detail.at}:${detail.entry?.id ?? "new"}:${detail.entry?.updated_at ?? ""}`
      : detail.at === "preview"
        ? `preview:${detail.file.id}`
        : detail.at;

  const detailScreen = () => <Fragment key={detailKey}>{detailBody()}</Fragment>;

  const detailBody = () => {
    if (!detail) return null;
    switch (detail.at) {
      case "entry":
        return (
          <Entry
            entry={detail.entry}
            onBack={() => setDetail(null)}
            onEdit={() => setDetail({ at: "edit", entry: detail.entry })}
            onChanged={(saved) => {
              changed();
              setDetail({ at: "entry", entry: saved });
            }}
          />
        );
      case "edit":
        return (
          <EntryEdit
            entry={detail.entry}
            sync={sync}
            onCancel={() => setDetail(detail.entry ? { at: "entry", entry: detail.entry } : null)}
            onSaved={(saved) => {
              changed();
              setDetail({ at: "entry", entry: saved });
            }}
            onDeleted={() => {
              changed();
              setDetail(null);
              toast(t("start.entry_deleted"));
            }}
          />
        );
      case "preview":
        return <Preview file={detail.file} onBack={() => setDetail(null)} />;
      case "keys":
        return <Keys sync={sync} onBack={() => setDetail(null)} />;
      case "backup":
        return <PhoneBackup onBack={() => setDetail(null)} />;
      case "trash":
        return <Trash sync={sync} onBack={() => setDetail(null)} />;
      case "storage":
        return (
          <Storage
            onBack={() => {
              setDetail(null);
              refreshSync();
            }}
          />
        );
      case "health":
        return <Health onBack={() => setDetail(null)} onOpen={(entry) => setDetail({ at: "entry", entry })} />;
    }
  };

  // A file or an entry opened from a list comes back to that list as it was:
  // the folder, the search and the scroll stay, so the list is kept mounted
  // under the detail. Screens reached from Silo still start fresh, since they
  // change what Silo shows.
  const parksList = detail !== null && (detail.at === "preview" || detail.at === "entry" || detail.at === "edit");
  if (detail && !wide && !parksList) return detailScreen();

  const tabs: { id: Tab; label: string; Icon: typeof KeyRound }[] = [
    { id: "passwords", label: t("start.tab_passwords"), Icon: KeyRound },
    { id: "files", label: t("start.tab_files"), Icon: Folder },
    { id: "silo", label: t("start.tab_silo"), Icon: ShieldCheck },
  ];

  const tabScreen = (
    <>
      {leftOut && (
        <Notice tone="warning" style={{ margin: "10px 16px 0" }}>
          <strong>{t("start.left_out_title")}</strong> {t("start.left_out_body")}
        </Notice>
      )}
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
      {tab === "silo" && <Silo siloId={siloId} siloName={siloName} sync={sync} onSynced={refreshSync} onKeys={() => setDetail({ at: "keys" })} onBackup={() => setDetail({ at: "backup" })} onTrash={() => setDetail({ at: "trash" })} onHealth={() => setDetail({ at: "health" })} onStorage={() => setDetail({ at: "storage" })} onLocked={onLocked} />}
    </>
  );

  const tabButtons = tabs.map(({ id, label, Icon }) => (
    <button
      key={id}
      className="tab"
      role="tab"
      aria-selected={tab === id}
      onClick={() => {
        setTab(id);
        if (wide) setDetail(null);
      }}
    >
      <span className="tab-icon" aria-hidden>
        <Icon size={22} />
      </span>
      {label}
    </button>
  ));

  // A list and what is open from it, side by side, with the tabs down the
  // side. On a phone the detail takes the whole screen instead.
  if (wide) {
    return (
      <div className="wide-shell">
        <nav className="rail" role="tablist" aria-orientation="vertical">
          {tabButtons}
        </nav>
        <div className="pane list-pane">
          <div className="screen">{tabScreen}</div>
        </div>
        <div className="pane detail-pane">
          {detail ? (
            detailScreen()
          ) : (
            <div className="screen">
              <div className="empty-detail">
                <EmptyState
                  icon={tab === "passwords" ? <KeyRound size={26} /> : tab === "files" ? <Folder size={26} /> : <ShieldCheck size={26} />}
                  title={
                    tab === "passwords"
                      ? t("start.choose_entry")
                      : tab === "files"
                        ? t("start.choose_file")
                        : t("start.choose_setting")
                  }
                  hint={t("start.choose_hint")}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const parked = detail !== null && parksList;
  return (
    <>
      <div className={parked ? "screen screen-parked" : "screen"} aria-hidden={parked || undefined} inert={parked || undefined}>
        {tabScreen}
        <nav className="tabbar" role="tablist">
          {tabButtons}
        </nav>
      </div>
      {parked && detailScreen()}
    </>
  );
}
