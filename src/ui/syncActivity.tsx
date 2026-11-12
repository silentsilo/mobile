import { listen } from "@tauri-apps/api/event";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type SyncReport } from "../api";
import { formatBytes } from "../shared/format";
import { t } from "../i18n";

/** Where a running sync pass is. Gone once the pass reports its end. */
export type SyncProgress = {
  silo_id: string;
  phase:
    | "sending-changes"
    | "uploading"
    | "fetching-changes"
    | "downloading"
    | "importing"
    | "applying"
    | "compacting"
    | "checking";
  done: number;
  total: number;
  /**
   * How much of the file this step moves has moved, and how big it is. Both
   * zero on the phases counted in items. Only an upload fills them, and it
   * is the one that needs them: backing up a video, `done` stands still for
   * minutes while these move.
   */
  bytes_done: number;
  bytes_total: number;
  file_id: string | null;
  name: string | null;
};

type Activity = {
  /** The step a pass is on, for the marker on the file it moves. */
  progress: SyncProgress | null;
  /** A pass runs for this silo: from Sync pressed or its first step until its report. */
  running: boolean;
  /** The last pass that ran, and when it ended (ms), for the status lines. */
  last: SyncReport | null;
  lastAt: number;
  /** Re-renders the status lines while a copy's retry counts down. */
  now: number;
  leftOut: boolean;
  behind: boolean;
  begin: () => void;
  settle: () => void;
};

const nothing = () => undefined;
const SyncActivity = createContext<Activity>({
  progress: null,
  running: false,
  last: null,
  lastAt: 0,
  now: 0,
  leftOut: false,
  behind: false,
  begin: nothing,
  settle: nothing,
});

export const useSyncProgress = () => useContext(SyncActivity).progress;

/** Whether a pass is running for the silo on screen, whoever started it. */
export const useSyncRunning = () => useContext(SyncActivity).running;

/** Whether the last pass found the silo's key replaced without this phone:
 * it still opens its own copy, but nothing it does reaches storage. */
export const useLeftOut = () => useContext(SyncActivity).leftOut;
/** This phone fell behind a compaction and needs rebuilding from storage. */
export const useBehind = () => useContext(SyncActivity).behind;

/** What a status line says of the last pass when something needs saying, or null. */
export function useSyncTrouble(): string | null {
  const { last, lastAt } = useContext(SyncActivity);
  if (!last) return null;
  if (last.needs_update) return t("start.needs_update_line");
  if (last.error) return t("start.sync_stopped_line");
  // Stopped before any copy: nothing was checked, so never "Synced".
  if (last.needs_rebuild || last.needs_rejoin || last.key_material_replaced) {
    return t("silo.status_not_syncing");
  }
  return copyTrouble(last, lastAt);
}

/** One pass now, as Sync asks: the status line says "Syncing…" from the
 * press, and stops when it ends, a skipped or failed pass included. */
export function useSyncNow() {
  const { begin, settle } = useContext(SyncActivity);
  return useCallback(async () => {
    begin();
    try {
      return await api.syncNow();
    } finally {
      settle();
    }
  }, [begin, settle]);
}

/** The copies the last pass could not reach, and when the next try is, in
 * a sentence; null when every copy kept up. `at` is when the report came. */
export function copyTrouble(report: SyncReport, at: number): string | null {
  const copies = report.targets ?? [];
  // A retired copy answers; it is never tried again, so no countdown.
  const retired = copies.filter((copy) => copy.retired);
  const stuck = copies.filter((copy) => !copy.retired && (copy.failed || copy.waiting));
  if (stuck.length === 0) {
    if (retired.length === 0) return null;
    const label = retired.map((copy) => copy.label).filter(Boolean).join(", ") || t("start.copy_backup_storage");
    return t("start.copy_retired", { label });
  }
  const label =
    stuck
      .map((copy) => copy.label)
      .filter(Boolean)
      .join(", ") || t("start.copy_backup_storage");
  const wait = Math.min(...stuck.map((copy) => Math.max(0, copy.retry_in)));
  const left = at + wait * 1000 - Date.now();
  if (left < 60_000) return t("start.copy_unreachable_soon", { label });
  return t("start.copy_unreachable_retry", { label, count: Math.ceil(left / 60_000) });
}

/** The one line a running pass shows: "Syncing…" throughout, or the file or
 * the phone backup items it is moving. No step counter: each copy restarts
 * its own, which read as several syncs in a row. */
export function describeProgress(p: SyncProgress | null): string {
  if (!p) return t("start.progress_syncing");
  // Before the name, because the line is ellipsized and this is the part
  // that moves: on one large file the name tells you nothing new.
  const bytes =
    p.bytes_total > 0
      ? ` · ${t("start.of", { done: formatBytes(p.bytes_done), total: formatBytes(p.bytes_total) })}`
      : "";
  const name = p.name ? ` · ${p.name}` : "";
  switch (p.phase) {
    case "uploading":
      if (bytes || name) return `${t("start.progress_uploading")}${bytes}${name}`;
      break;
    case "downloading":
      if (bytes || name) return `${t("start.progress_downloading")}${bytes}${name}`;
      break;
    case "importing":
      if (p.total > 0) return t("start.progress_importing_count", { count: p.total });
      break;
  }
  return t("start.progress_syncing");
}

/**
 * Listens to the sync pass for as long as a silo is open: what is moving
 * now, and when the pass ends (`onReport`) or remote changes land
 * (`onChanged`), so screens refresh without being reopened.
 */
export function SyncActivityProvider({
  children,
  siloId,
  onReport,
  onChanged,
}: {
  children: ReactNode;
  /** The silo on screen. Other open silos sync in the background too, and
   * their passes are not this one's. */
  siloId: string;
  onReport: () => void;
  onChanged: () => void;
}) {
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<{ report: SyncReport; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [leftOut, setLeftOut] = useState(false);
  const [behind, setBehind] = useState(false);
  // Sync presses still waiting for their answer. The pass a press waits out
  // reports first, and "Syncing…" must not drop out before the press's own.
  const pressed = useRef(0);

  useEffect(() => {
    setProgress(null);
    setRunning(false);
    setLast(null);
    pressed.current = 0;
    const stops = [
      listen<SyncProgress>("sync-progress", (event) => {
        if (event.payload.silo_id !== siloId) return;
        setProgress(event.payload);
        setRunning(true);
      }),
      listen<SyncReport | null>("sync-report", (event) => {
        const report = event.payload;
        const from = report?.silo_id;
        if (from && from !== siloId) return;
        // Every report ends the pass on screen: an error, a skip and a pass
        // the phone stopped with the app included.
        setProgress(null);
        if (pressed.current === 0) setRunning(false);
        // Every pass says it again, the background ones included, which
        // until now nobody looked at: only "Sync now" told the user.
        if (report?.configured && !report.skipped) {
          if (!report.error) {
            setLeftOut(Boolean(report.needs_rejoin));
            setBehind(Boolean(report.needs_rebuild));
          }
          setLast({ report, at: Date.now() });
        }
        onReport();
      }),
      listen("vault-changed", () => onChanged()),
    ];
    return () => {
      for (const stop of stops) void stop.then((unlisten) => unlisten());
    };
  }, [siloId, onReport, onChanged]);

  // A copy's "trying again in N min" counts down between reports.
  const counting = Boolean(last?.report.targets?.some((copy) => !copy.retired && (copy.failed || copy.waiting)));
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [counting]);

  const begin = useCallback(() => {
    pressed.current += 1;
    setRunning(true);
  }, []);
  const settle = useCallback(() => {
    pressed.current = Math.max(0, pressed.current - 1);
    if (pressed.current === 0) {
      setRunning(false);
      setProgress(null);
    }
  }, []);

  const value = useMemo<Activity>(
    () => ({ progress, running, last: last?.report ?? null, lastAt: last?.at ?? 0, now, leftOut, behind, begin, settle }),
    [progress, running, last, now, leftOut, behind, begin, settle],
  );

  return <SyncActivity.Provider value={value}>{children}</SyncActivity.Provider>;
}
