import { Camera, EllipsisVertical, File, FilePlus, FileText, Folder, FolderPlus, Image, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type SyncStatus } from "../api";
import { formatAppError } from "../shared/errors";
import { formatBytes } from "../shared/format";
import type { FileEntry, VaultEntry } from "../shared/types";
import { addAll, photoName } from "../shared/importing";
import { Sheet, TopBar, useToast } from "../ui/chrome";
import { useSyncProgress } from "../ui/syncActivity";
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

export function Files({
  siloName,
  sync,
  reloadKey,
  onOpenFile,
}: {
  siloName: string;
  sync: SyncStatus | null;
  reloadKey: number;
  onOpenFile: (file: FileEntry) => void;
}) {
  const syncing = useSyncProgress();
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [items, setItems] = useState<VaultEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [naming, setNaming] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [acting, setActing] = useState<VaultEntry | null>(null);
  const [renaming, setRenaming] = useState<VaultEntry | null>(null);
  const [newName, setNewName] = useState("");
  const toast = useToast();

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
  const here = trail[trail.length - 1];

  // Remote changes landed: the folder on screen may have gained or lost files.
  const hereId = here?.id;
  useEffect(() => {
    if (reloadKey > 0 && hereId) void load(hereId);
  }, [reloadKey, hereId, load]);

  const chooseFiles = async () => {
    setAdding(false);
    if (!here) return;
    try {
      const files = await api.pickFiles();
      if (!files.length) return;
      const summary = await addAll(files, here.id, (done) => setProgress(`Adding ${Math.min(done + 1, files.length)} of ${files.length}`));
      toast(summary);
    } catch (e) {
      toast(formatAppError(e));
    } finally {
      setProgress(null);
      void load(here.id);
    }
  };

  const takePhoto = async () => {
    setAdding(false);
    if (!here) return;
    try {
      const path = await api.takePhoto();
      if (!path) return;
      setProgress("Adding the photo");
      await api.importPhoto(path, photoName(), here.id);
      toast("Photo added.");
    } catch (e) {
      toast(formatAppError(e));
    } finally {
      setProgress(null);
      void load(here.id);
    }
  };

  const rename = async () => {
    if (!renaming || !here || !newName.trim()) return;
    try {
      if (renaming.kind === "folder") await api.renameFolder(renaming.id, newName.trim());
      else await api.renameFile(renaming.id, newName.trim());
      setRenaming(null);
      void load(here.id);
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const trash = async (entry: VaultEntry) => {
    setActing(null);
    if (!here) return;
    try {
      if (entry.kind === "folder") await api.trashFolder(entry.id);
      else await api.trashFile(entry.id);
      toast("Moved to the trash.");
      void load(here.id);
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const newFolder = async () => {
    if (!here || !folderName.trim()) return;
    try {
      await api.createFolder(here.id, folderName.trim());
      setNaming(false);
      setFolderName("");
      void load(here.id);
    } catch (e) {
      toast(formatAppError(e));
    }
  };

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
        <button className="btn inline" style={{ padding: "0 12px" }} aria-label="Add" disabled={!here || progress !== null} onClick={() => setAdding(true)}>
          <Plus size={20} />
        </button>
      </div>
      {progress && <div className="notice" style={{ margin: "0 16px 10px" }}>{progress}</div>}
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
              <span role="button" className="icon-btn" aria-label={`More for ${item.name}`} onClick={(e) => { e.stopPropagation(); setActing(item); }}>
                <EllipsisVertical size={20} color="var(--text-dim)" />
              </span>
            </button>
          ) : (
            <button key={item.id} className="row divide" onClick={() => onOpenFile(item)}>
              <span className="tile">{fileIcon(item)}</span>
              <span className="row-text">
                <span className="row-title" style={{ fontWeight: 600 }}>{item.name}</span>
                <span className="row-sub">
                  {syncing?.file_id === item.id
                    ? syncing.phase === "uploading"
                      ? "Uploading…"
                      : "Downloading…"
                    : `${formatBytes(item.size_bytes)} · ${fileDate(item.updated_at)}`}
                </span>
              </span>
              <span role="button" className="icon-btn" aria-label={`More for ${item.name}`} onClick={(e) => { e.stopPropagation(); setActing(item); }}>
                <EllipsisVertical size={20} color="var(--text-dim)" />
              </span>
            </button>
          ),
        )}
      </div>

      <Sheet open={adding} onClose={() => setAdding(false)} title="Add to this folder">
        <div className="panel">
          <button className="row" style={{ minHeight: 56 }} onClick={() => void chooseFiles()}>
            <FilePlus size={20} color="var(--accent-hover)" />
            <span className="row-title" style={{ flex: 1 }}>Files from this phone</span>
          </button>
          <button className="row divide" style={{ minHeight: 56 }} onClick={() => void takePhoto()}>
            <Camera size={20} color="var(--accent-hover)" />
            <span className="row-text">
              <span className="row-title">Take a photo</span>
              <span className="row-sub">Goes into the silo, not the gallery</span>
            </span>
          </button>
          <button className="row divide" style={{ minHeight: 56 }} onClick={() => { setAdding(false); setNaming(true); }}>
            <FolderPlus size={20} color="var(--accent-hover)" />
            <span className="row-title" style={{ flex: 1 }}>New folder</span>
          </button>
        </div>
      </Sheet>

      <Sheet open={acting !== null} onClose={() => setActing(null)} title={acting?.name}>
        <button
          className="btn secondary"
          onClick={() => {
            setNewName(acting?.name ?? "");
            setRenaming(acting);
            setActing(null);
          }}
        >
          Rename
        </button>
        <button className="btn danger" onClick={() => acting && void trash(acting)}>
          Move to trash
        </button>
      </Sheet>

      <Sheet open={renaming !== null} onClose={() => setRenaming(null)} title="Rename">
        <div className="input">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && void rename()} />
        </div>
        <button className="btn" disabled={!newName.trim()} onClick={() => void rename()}>
          Save
        </button>
      </Sheet>

      <Sheet open={naming} onClose={() => setNaming(false)} title="New folder">
        <div className="input">
          <input value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="Folder name" autoFocus onKeyDown={(e) => e.key === "Enter" && void newFolder()} />
        </div>
        <button className="btn" disabled={!folderName.trim()} onClick={() => void newFolder()}>
          Create
        </button>
      </Sheet>
    </div>
  );
}
