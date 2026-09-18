import { listen } from "@tauri-apps/api/event";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { formatBytes } from "../shared/format";

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

export const useSyncProgress = () => useContext(SyncActivity);

/** What a status line says about a step, in a few words. */
export function describeProgress(p: SyncProgress): string {
  const count = p.total > 1 ? ` ${Math.min(p.done + 1, p.total)} of ${p.total}` : "";
  // Before the name, because the line is ellipsized and this is the part
  // that moves: on one large file the name tells you nothing new.
  const bytes = p.bytes_total > 0 ? ` · ${formatBytes(p.bytes_done)} of ${formatBytes(p.bytes_total)}` : "";
  const name = p.name ? ` · ${p.name}` : "";
  switch (p.phase) {
    case "sending-changes":
      return `Sending changes${count}`;
    case "uploading":
      return `Uploading${count}${bytes}${name}`;
    case "fetching-changes":
      return `Getting changes${count}`;
    case "downloading":
      return `Downloading${count}${bytes}${name}`;
    case "importing":
      return `Adding from phone backup${count}`;
  }
}

/**
 * Listens to the sync pass for as long as a silo is open: what is moving
 * now, and when the pass ends (`onReport`) or remote changes land
 * (`onChanged`), so screens refresh without being reopened.
 */
export function SyncActivityProvider({
  children,
  onReport,
  onChanged,
}: {
  children: ReactNode;
  onReport: () => void;
  onChanged: () => void;
}) {
  const [progress, setProgress] = useState<SyncProgress | null>(null);

  useEffect(() => {
    const stops = [
      listen<SyncProgress>("sync-progress", (event) => setProgress(event.payload)),
      listen("sync-report", () => {
        setProgress(null);
        onReport();
      }),
      listen("vault-changed", () => onChanged()),
    ];
    return () => {
      for (const stop of stops) void stop.then((unlisten) => unlisten());
    };
  }, [onReport, onChanged]);

  return <SyncActivity.Provider value={progress}>{children}</SyncActivity.Provider>;
}
