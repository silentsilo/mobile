import { listen } from "@tauri-apps/api/event";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { formatBytes } from "../shared/format";
import { t } from "../i18n";

/** Where a running sync pass is. Gone once the pass reports its end. */
export type SyncProgress = {
  silo_id: string;
  phase: "sending-changes" | "uploading" | "fetching-changes" | "downloading" | "importing";
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

const SyncActivity = createContext<SyncProgress | null>(null);
const LeftOut = createContext(false);

export const useSyncProgress = () => useContext(SyncActivity);

/** Whether the last pass found the silo's key replaced without this phone:
 * it still opens its own copy, but nothing it does reaches storage. */
export const useLeftOut = () => useContext(LeftOut);

/** What a status line says about a step, in a few words. */
export function describeProgress(p: SyncProgress): string {
  const count =
    p.total > 1 ? ` ${t("start.of", { done: Math.min(p.done + 1, p.total), total: p.total })}` : "";
  // Before the name, because the line is ellipsized and this is the part
  // that moves: on one large file the name tells you nothing new.
  const bytes =
    p.bytes_total > 0
      ? ` · ${t("start.of", { done: formatBytes(p.bytes_done), total: formatBytes(p.bytes_total) })}`
      : "";
  const name = p.name ? ` · ${p.name}` : "";
  switch (p.phase) {
    case "sending-changes":
      return `${t("start.progress_sending")}${count}`;
    case "uploading":
      return `${t("start.progress_uploading")}${count}${bytes}${name}`;
    case "fetching-changes":
      return `${t("start.progress_fetching")}${count}`;
    case "downloading":
      return `${t("start.progress_downloading")}${count}${bytes}${name}`;
    case "importing":
      return `${t("start.progress_importing")}${count}`;
  }
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
  const [leftOut, setLeftOut] = useState(false);

  useEffect(() => {
    const stops = [
      listen<SyncProgress>("sync-progress", (event) => {
        if (event.payload.silo_id === siloId) setProgress(event.payload);
      }),
      listen<{ silo_id?: string; configured?: boolean; skipped?: boolean; needs_rejoin?: boolean } | null>(
        "sync-report",
        (event) => {
          const report = event.payload;
          const from = report?.silo_id;
          if (from && from !== siloId) return;
          setProgress(null);
          // Every pass says it again, the background ones included, which
          // until now nobody looked at: only "Sync now" told the user.
          if (report?.configured && !report.skipped) setLeftOut(Boolean(report.needs_rejoin));
          onReport();
        },
      ),
      listen("vault-changed", () => onChanged()),
    ];
    return () => {
      for (const stop of stops) void stop.then((unlisten) => unlisten());
    };
  }, [siloId, onReport, onChanged]);

  return (
    <SyncActivity.Provider value={progress}>
      <LeftOut.Provider value={leftOut}>{children}</LeftOut.Provider>
    </SyncActivity.Provider>
  );
}
