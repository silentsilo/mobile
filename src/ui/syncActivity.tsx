import { listen } from "@tauri-apps/api/event";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/** Where a running sync pass is. Gone once the pass reports its end. */
export type SyncProgress = {
  silo_id: string;
  phase: "sending-changes" | "uploading" | "fetching-changes" | "downloading" | "importing";
  done: number;
  total: number;
  file_id: string | null;
  name: string | null;
};

const SyncActivity = createContext<SyncProgress | null>(null);

export const useSyncProgress = () => useContext(SyncActivity);

/** What a status line says about a step, in a few words. */
export function describeProgress(p: SyncProgress): string {
  const count = p.total > 1 ? ` ${Math.min(p.done + 1, p.total)} of ${p.total}` : "";
  switch (p.phase) {
    case "sending-changes":
      return `Sending changes${count}`;
    case "uploading":
      return `Uploading${count}${p.name ? ` · ${p.name}` : ""}`;
    case "fetching-changes":
      return `Getting changes${count}`;
    case "downloading":
      return `Downloading${count}${p.name ? ` · ${p.name}` : ""}`;
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
