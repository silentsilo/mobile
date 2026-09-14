import { ChevronRight, Folder } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type Offered } from "../api";
import { formatAppError } from "../shared/errors";
import { formatBytes } from "../shared/format";
import { addAll } from "../shared/importing";
import type { VaultEntry } from "../shared/types";
import { TopBar, useToast } from "../ui/chrome";

type Crumb = { id: string; name: string };

/** Where files another app shared go: pick a folder, save them there. */
export function SaveShared({ files, siloName, onDone }: { files: Offered[]; siloName: string; onDone: () => void }) {
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [folders, setFolders] = useState<VaultEntry[] | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async (id: string) => {
    setFolders(null);
    try {
      setFolders((await api.listFolder(id)).filter((e) => e.kind === "folder"));
    } catch (e) {
      setError(formatAppError(e));
    }
  }, []);

  useEffect(() => {
    api.rootFolder().then(
      (root) => {
        setTrail([{ id: root.id, name: siloName }]);
        void load(root.id);
      },
      (e) => setError(formatAppError(e)),
    );
  }, [load, siloName]);

  const here = trail[trail.length - 1];

  const save = async () => {
    if (!here) return;
    setError(null);
    const summary = await addAll(files, here.id, setSaving);
    setSaving(null);
    toast(summary);
    onDone();
  };

  return (
    <div className="screen">
      <TopBar
        onBack={saving === null ? (trail.length > 1 ? () => { const next = trail.slice(0, -1); setTrail(next); void load(next[next.length - 1]!.id); } : onDone) : undefined}
        backLabel={trail.length > 1 ? trail[trail.length - 2]!.name : "Cancel"}
        title={here?.name}
      />
      <div className="screen-body tight" style={{ gap: 14 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "0 4px" }}>
          <h1 className="title">Save to the silo</h1>
          <p className="hint">
            {files.length === 1 ? files[0]!.name : `${files.length} files`}
            {files.every((f) => f.size >= 0) && `, ${formatBytes(files.reduce((n, f) => n + f.size, 0))}`}
          </p>
        </div>
        {error && <div className="notice error">{error}</div>}
        <div className="panel">
          {folders?.length === 0 && <p className="hint" style={{ padding: 16 }}>No folders here.</p>}
          {folders?.map((f, i) => (
            <button
              key={f.id}
              className={`row${i ? " divide" : ""}`}
              disabled={saving !== null}
              onClick={() => {
                setTrail([...trail, { id: f.id, name: f.name }]);
                void load(f.id);
              }}
            >
              <Folder size={20} color="var(--accent-hover)" />
              <span className="row-title" style={{ flex: 1 }}>{f.name}</span>
              <ChevronRight size={18} color="var(--text-dim)" />
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button className="btn" disabled={!here || saving !== null} onClick={() => void save()}>
          {saving === null ? `Save in ${here?.name ?? ""}` : `Saving ${Math.min(saving + 1, files.length)} of ${files.length}`}
        </button>
      </div>
    </div>
  );
}
