import { ChevronRight, File, FileText, Folder, Image, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type SyncStatus } from "../api";
import { formatAppError } from "../shared/errors";
import { formatBytes } from "../shared/format";
import type { FileEntry, VaultEntry } from "../shared/types";
import { TopBar } from "../ui/chrome";
import { SiloHeader } from "./Passwords";

type Crumb = { id: string; name: string };
type Sort = "name" | "newest";

export function fileDate(seconds: number) {
  return new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function fileIcon(file: FileEntry, size = 20) {
  const mime = file.mime_type ?? "";
  if (mime.startsWith("image/")) return <Image size={size} />;
  if (mime === "application/pdf" || mime.startsWith("text/")) return <FileText size={size} />;
  return <File size={size} />;
}

export function Files({ siloName, sync, onOpenFile }: { siloName: string; sync: SyncStatus | null; onOpenFile: (file: FileEntry) => void }) {
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [items, setItems] = useState<VaultEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (folderId: string) => {
    setItems(null);
    setError(null);
    try {
      setItems(await api.listFolder(folderId));
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

  const enter = (crumb: Crumb) => {
    setTrail([...trail, crumb]);
    setQuery("");
    void load(crumb.id);
  };

  const up = () => {
    const next = trail.slice(0, -1);
    setTrail(next);
    setQuery("");
    void load(next[next.length - 1]!.id);
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (items ?? []).filter((i) => !q || i.name.toLowerCase().includes(q));
    const folders = list.filter((i) => i.kind === "folder");
    const files = list.filter((i) => i.kind === "file");
    const order = (a: VaultEntry, b: VaultEntry) => (sort === "name" ? a.name.localeCompare(b.name) : b.updated_at - a.updated_at);
    return [...folders.sort(order), ...files.sort(order)];
  }, [items, query, sort]);

  const nested = trail.length > 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {nested ? <TopBar onBack={up} backLabel={trail[trail.length - 2]!.name} title={trail[trail.length - 1]!.name} /> : <SiloHeader siloName={siloName} sync={sync} />}
      <div style={{ display: "flex", gap: 8, padding: "0 16px 10px" }}>
        <div className="input" style={{ flex: 1, background: "var(--surface-muted)" }}>
          <Search size={20} color="var(--text-dim)" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search this folder" autoCapitalize="none" autoCorrect="off" />
        </div>
        <button className="btn secondary inline" style={{ padding: "0 12px", fontSize: "0.9rem" }} onClick={() => setSort(sort === "name" ? "newest" : "name")}>
          {sort === "name" ? "Name" : "Newest"}
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {error && <div className="notice error" style={{ margin: 16 }}>{error}</div>}
        {items && shown.length === 0 && (
          <p className="hint" style={{ textAlign: "center", padding: 32 }}>
            {query ? "Nothing in this folder matches." : "This folder is empty."}
          </p>
        )}
        {shown.map((item) =>
          item.kind === "folder" ? (
            <button key={item.id} className="row divide" onClick={() => enter({ id: item.id, name: item.name })}>
              <span className="tile" style={{ background: "rgba(139, 92, 246, 0.35)", color: "#fff" }}>
                <Folder size={20} />
              </span>
              <span className="row-text">
                <span className="row-title" style={{ fontWeight: 600 }}>{item.name}</span>
              </span>
              <ChevronRight size={20} color="var(--text-dim)" />
            </button>
          ) : (
            <button key={item.id} className="row divide" onClick={() => onOpenFile(item)}>
              <span className="tile">{fileIcon(item)}</span>
              <span className="row-text">
                <span className="row-title" style={{ fontWeight: 600 }}>{item.name}</span>
                <span className="row-sub">
                  {formatBytes(item.size_bytes)} · {fileDate(item.updated_at)}
                </span>
              </span>
            </button>
          ),
        )}
      </div>
    </div>
  );
}
