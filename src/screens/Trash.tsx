import { Folder, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type SyncStatus } from "../api";
import { formatAppError } from "../shared/errors";
import { formatBytes } from "../shared/format";
import type { TrashItem } from "../shared/types";
import { EmptyState, Notice, Sheet, Skeleton, TopBar, useToast } from "../ui/chrome";
import { fileIcon } from "./Files";
import { haptic } from "../ui/haptics";

/** Said before a purge: the app never deletes from a never-delete copy. */
function archiveNote(archiveTargets: number): string {
  if (archiveTargets === 0) return "";
  return archiveTargets === 1
    ? " One of your copies is a never-delete copy, so the content stays there until that storage's own rules remove it."
    : ` ${archiveTargets} of your copies are never-delete copies, so the content stays there until that storage's own rules remove it.`;
}

export function Trash({ sync, onBack }: { sync: SyncStatus | null; onBack: () => void }) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [chosen, setChosen] = useState<TrashItem | null>(null);
  const [emptying, setEmptying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(() => {
    api.listTrash().then(setItems, (e) => setError(formatAppError(e)));
  }, []);

  useEffect(load, [load]);

  const act = async (what: () => Promise<unknown>, done: string) => {
    setChosen(null);
    setEmptying(false);
    try {
      await what();
      toast(done);
    } catch (e) {
      toast(formatAppError(e));
    }
    load();
  };

  return (
    <div className="screen">
      <TopBar onBack={onBack} backLabel="Silo" />
      <div className="screen-body tight" style={{ gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
          <h1 className="title">Trash</h1>
          <p className="hint">Deleted files and folders stay here, on every device, until the trash is emptied.</p>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {!items && !error && <Skeleton avatar={false} rows={4} />}
        {items?.length === 0 && (
          <EmptyState icon={<Trash2 size={26} />} title="The trash is empty" hint="Files and folders you delete wait here until the trash is emptied." />
        )}
        {items && items.length > 0 && (
          <div className="panel">
            {items.map((item, i) => (
              <button key={item.id} className={`row${i ? " divide" : ""}`} onClick={() => setChosen(item)}>
                <span className="tile">{item.kind === "folder" ? <Folder size={20} /> : fileIcon(item)}</span>
                <span className="row-text">
                  <span className="row-title">{item.name}</span>
                  <span className="row-sub">
                    {item.original_path || "/"}
                    {item.kind === "file" && ` · ${formatBytes(item.size_bytes)}`}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="spacer" />
        {items && items.length > 0 && (
          <button className="btn danger" onClick={() => setEmptying(true)}>
            <Trash2 size={18} />
            Empty trash
          </button>
        )}
      </div>

      <Sheet open={chosen !== null} onClose={() => setChosen(null)} title={chosen?.name}>
        {chosen && (
          <>
            <p className="hint">Delete for good cannot be undone.{archiveNote(sync?.archive_targets ?? 0)}</p>
            <button
              className="btn secondary"
              onClick={() =>
                void act(() => (chosen.kind === "folder" ? api.restoreFolder(chosen.id) : api.restoreFile(chosen.id)), "Restored.")
              }
            >
              <RotateCcw size={18} />
              Restore
            </button>
            <button className="btn danger" onClick={() => {
                haptic("heavy");
                void act(() => api.purgeTrash([chosen.id]), "Deleted for good.");
              }}>
              Delete for good
            </button>
          </>
        )}
      </Sheet>

      <Sheet open={emptying} onClose={() => setEmptying(false)} title="Empty trash?">
        <p className="hint">
          Everything in the trash is deleted for good, on every device, once they sync. This cannot be undone.
          {archiveNote(sync?.archive_targets ?? 0)}
        </p>
        <button className="btn danger" onClick={() => {
            haptic("heavy");
            void act(() => api.purgeTrash([]), "Trash emptied.");
          }}>
          Empty trash
        </button>
        <button className="btn secondary" onClick={() => setEmptying(false)}>
          Cancel
        </button>
      </Sheet>
    </div>
  );
}
