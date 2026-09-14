import { Folder, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { formatBytes } from "../shared/format";
import type { TrashItem } from "../shared/types";
import { Sheet, TopBar, useToast } from "../ui/chrome";
import { fileIcon } from "./Files";

export function Trash({ onBack }: { onBack: () => void }) {
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
        {error && <div className="notice error">{error}</div>}
        {items?.length === 0 && <p className="hint" style={{ textAlign: "center", padding: 24 }}>The trash is empty.</p>}
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
            <button
              className="btn secondary"
              onClick={() =>
                void act(() => (chosen.kind === "folder" ? api.restoreFolder(chosen.id) : api.restoreFile(chosen.id)), "Restored.")
              }
            >
              <RotateCcw size={18} />
              Restore
            </button>
            <button className="btn danger" onClick={() => void act(() => api.purgeTrash([chosen.id]), "Deleted for good.")}>
              Delete for good
            </button>
          </>
        )}
      </Sheet>

      <Sheet open={emptying} onClose={() => setEmptying(false)} title="Empty the trash?">
        <p className="hint">Everything in the trash is deleted for good, on every device, once they sync. This cannot be undone.</p>
        <button className="btn danger" onClick={() => void act(() => api.purgeTrash([]), "Trash emptied.")}>
          Empty trash
        </button>
        <button className="btn secondary" onClick={() => setEmptying(false)}>
          Cancel
        </button>
      </Sheet>
    </div>
  );
}
