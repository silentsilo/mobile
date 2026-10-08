import { Camera, Check, EllipsisVertical, File, FilePlus, FileText, Folder, FolderInput, FolderPlus, Image, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type SyncStatus } from "../api";
import { formatAppError } from "../shared/errors";
import { formatBytes, formatDate } from "../shared/format";
import type { FileEntry, FolderEntry, VaultEntry } from "../shared/types";
import { addAll, photoName } from "../shared/importing";
import { useBackLayer } from "../ui/back";
import { AddButton, EmptyState, Notice, Sheet, Skeleton, TopBar, useToast } from "../ui/chrome";
import { isIOS } from "../ui/platform";
import { useSyncProgress } from "../ui/syncActivity";
import { SiloHeader } from "./Passwords";
import { haptic } from "../ui/haptics";

type Crumb = { id: string; name: string };
type Sort = "name" | "newest";
type Hit = VaultEntry & { folder_path: string };

/** Held for this long, a row starts a selection instead of opening. */
const LONG_PRESS_MS = 450;

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
  // Several at once: a long press starts it, taps add and remove.
  const [selected, setSelected] = useState<Map<string, VaultEntry>>(new Map());
  // Moving: what, and the folders it can go to.
  const [moving, setMoving] = useState<VaultEntry[] | null>(null);
  const [folders, setFolders] = useState<FolderEntry[] | null>(null);
  // Typing two letters or more searches the whole silo.
  const [hits, setHits] = useState<Hit[] | null>(null);
  // Bumped by a change made here, so search results do not show what moved.
  const [edits, setEdits] = useState(0);
  const pressTimer = useRef<number | undefined>(undefined);
  const pressed = useRef(false);
  const toast = useToast();

  // The folder asked for last. A slower answer for one left a moment ago
  // would otherwise fill this one with its files.
  const asked = useRef<string | null>(null);
  const load = useCallback(async (folderId: string) => {
    asked.current = folderId;
    setItems(null);
    setError(null);
    try {
      const listed = await api.listFolder(folderId);
      if (asked.current === folderId) setItems(listed);
    } catch (e) {
      if (asked.current === folderId) setError(formatAppError(e));
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
    setSelected(new Map());
    void load(crumb.id);
  };

  const up = () => {
    const next = trail.slice(0, -1);
    setTrail(next);
    setQuery("");
    setSelected(new Map());
    void load(next[next.length - 1]!.id);
  };

  const searching = query.trim().length >= 2;
  useEffect(() => {
    if (!searching) {
      setHits(null);
      return;
    }
    const q = query.trim();
    // Only the latest query's answer lands; a slower earlier one is dropped.
    let live = true;
    const timer = window.setTimeout(() => {
      api.search(q).then(
        (found) => live && setHits(found),
        (e) => live && toast(formatAppError(e)),
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, searching, reloadKey, edits, toast]);

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
      setEdits((n) => n + 1);
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
      setEdits((n) => n + 1);
      void load(here.id);
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const selecting = selected.size > 0;
  useBackLayer(selecting, () => setSelected(new Map()));
  const toggle = (item: VaultEntry) => {
    const next = new Map(selected);
    if (next.has(item.id)) next.delete(item.id);
    else next.set(item.id, item);
    setSelected(next);
  };
  const pressStart = (item: VaultEntry) => {
    pressed.current = false;
    window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => {
      pressed.current = true;
      haptic("heavy");
      toggle(item);
    }, LONG_PRESS_MS);
  };
  const pressEnd = () => window.clearTimeout(pressTimer.current);
  /** A tap, unless it ended a long press. */
  const tap = (item: VaultEntry, open: () => void) => {
    if (pressed.current) {
      pressed.current = false;
      return;
    }
    if (selecting) toggle(item);
    else open();
  };
  const pressProps = (item: VaultEntry) => ({
    onPointerDown: () => pressStart(item),
    onPointerUp: pressEnd,
    onPointerLeave: pressEnd,
    onPointerCancel: pressEnd,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  // A folder found by search: the trail to it rebuilt from its path.
  const openFolderAt = async (target: FolderEntry | Hit) => {
    try {
      const all = await api.listAllFolders();
      const byPath = new Map(all.map((f) => [f.path, f]));
      const path = "path" in target && typeof target.path === "string" ? target.path : "";
      const parts = path.split("/").filter(Boolean);
      const crumbs: Crumb[] = [trail[0]!];
      let at = "";
      for (const part of parts) {
        at += `/${part}`;
        const f = byPath.get(at);
        if (!f) break;
        crumbs.push({ id: f.id, name: f.name });
      }
      setQuery("");
      setSelected(new Map());
      setTrail(crumbs);
      void load(crumbs[crumbs.length - 1]!.id);
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  const startMove = async (entries: VaultEntry[]) => {
    setActing(null);
    setMoving(entries);
    setFolders(null);
    try {
      setFolders(await api.listAllFolders());
    } catch (e) {
      toast(formatAppError(e));
      setMoving(null);
    }
  };

  // Where the chosen entries may go: not into a folder being moved or below it.
  const destinations = useMemo(() => {
    if (!folders || !moving) return [];
    const movedPaths = moving.filter((e) => e.kind === "folder").map((e) => folders.find((f) => f.id === e.id)?.path).filter(Boolean) as string[];
    return folders
      .filter((f) => !movedPaths.some((p) => f.path === p || f.path.startsWith(`${p}/`)))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [folders, moving]);

  const moveTo = async (destination: FolderEntry) => {
    if (!moving || !here) return;
    const list = moving;
    setMoving(null);
    let failed = 0;
    let reason = "";
    for (const [i, entry] of list.entries()) {
      setProgress(`Moving ${i + 1} of ${list.length}`);
      try {
        if (entry.kind === "folder") await api.moveFolder(entry.id, destination.id);
        else await api.moveFile(entry.id, destination.id);
      } catch (e) {
        failed += 1;
        reason ||= formatAppError(e);
      }
    }
    setProgress(null);
    setSelected(new Map());
    setEdits((n) => n + 1);
    toast(
      failed === list.length
        ? reason
        : failed
          ? `Moved ${list.length - failed} of ${list.length}. ${reason}`
          : list.length === 1
            ? "Moved."
            : `Moved ${list.length} items.`,
    );
    void load(here.id);
  };

  const trashSelected = async () => {
    if (!here) return;
    const list = [...selected.values()];
    setSelected(new Map());
    let failed = 0;
    let reason = "";
    for (const entry of list) {
      try {
        if (entry.kind === "folder") await api.trashFolder(entry.id);
        else await api.trashFile(entry.id);
      } catch (e) {
        failed += 1;
        reason ||= formatAppError(e);
      }
    }
    setEdits((n) => n + 1);
    toast(
      failed === list.length
        ? reason
        : failed
          ? `Moved ${list.length - failed} of ${list.length} to the trash. ${reason}`
          : list.length === 1
            ? "Moved to the trash."
            : `Moved ${list.length} items to the trash.`,
    );
    void load(here.id);
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
      {selecting ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px" }}>
          <button className="icon-btn" aria-label="Clear the selection" onClick={() => setSelected(new Map())}>
            <X size={22} />
          </button>
          <span style={{ flex: 1, fontWeight: 650 }}>{selected.size} selected</span>
          <button className="icon-btn" aria-label="Move the selection" onClick={() => void startMove([...selected.values()])}>
            <FolderInput size={22} />
          </button>
          <button className="icon-btn" aria-label="Move the selection to the trash" onClick={() => void trashSelected()}>
            <Trash2 size={22} />
          </button>
        </div>
      ) : nested ? (
        <TopBar onBack={up} backLabel={trail[trail.length - 2]!.name} title={trail[trail.length - 1]!.name} />
      ) : (
        <SiloHeader siloName={siloName} sync={sync} />
      )}
      <div style={{ display: "flex", gap: 8, padding: "0 16px 10px" }}>
        <div className="input" style={{ flex: 1 }}>
          <Search size={20} color="var(--text-dim)" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the silo" aria-label="Search the silo" autoCapitalize="none" autoCorrect="off" />
        </div>
        <button
          className="btn secondary inline small"
          style={{ padding: "0 12px" }}
          aria-label={sort === "name" ? "Sorted by name. Sort by newest" : "Sorted by newest. Sort by name"}
          onClick={() => setSort(sort === "name" ? "newest" : "name")}
        >
          {sort === "name" ? "Name" : "Newest"}
        </button>
        {isIOS && <AddButton label="Add to this folder" disabled={!here || progress !== null} onClick={() => setAdding(true)} />}
      </div>
      {progress && <div className="notice" style={{ margin: "0 16px 10px" }}>{progress}</div>}
      <div className="list-area">
        <div className="list-scroll">
          {error && <Notice tone="error" style={{ margin: 16 }}>{error}</Notice>}
          {((searching && !hits) || (!searching && !items)) && !error && <Skeleton avatar={false} />}
          {searching && hits && hits.length === 0 && (
            <EmptyState icon={<Search size={26} />} title="Nothing in the silo matches" hint="Search looks at file and folder names." />
          )}
          {searching &&
            hits?.map((hit) => (
              <button
                key={hit.id}
                className="row divide"
                onClick={() => (hit.kind === "folder" ? void openFolderAt(hit) : onOpenFile(hit as FileEntry))}
              >
                <span className={`tile${hit.kind === "folder" ? " folder" : ""}`}>
                  {hit.kind === "folder" ? <Folder size={20} /> : fileIcon(hit as FileEntry)}
                </span>
                <span className="row-text">
                  <span className="row-title">{hit.name}</span>
                  <span className="row-sub">{hit.folder_path === "/" ? siloName : hit.folder_path}</span>
                </span>
              </button>
            ))}
          {!searching &&
            items &&
            shown.length === 0 &&
            (query ? (
              <EmptyState icon={<Search size={26} />} title="Nothing in this folder matches" />
            ) : (
              <EmptyState
                icon={<Folder size={26} />}
                title="This folder is empty"
                hint="Add files from this phone, take a photo, or make a folder."
                action={here && progress === null ? { label: "Add to this folder", onClick: () => setAdding(true) } : undefined}
              />
            ))}
          {!searching &&
            shown.map((item) => {
              const ticked = selected.has(item.id);
              const folder = item.kind === "folder";
              return (
                // Two buttons side by side, so TalkBack reaches "More" on its own.
                <div key={item.id} className="row split divide">
                  <button
                    className="row-main"
                    aria-pressed={selecting ? ticked : undefined}
                    onClick={() => tap(item, () => (folder ? enter({ id: item.id, name: item.name }) : onOpenFile(item)))}
                    {...pressProps(item)}
                  >
                    <span className={`tile${folder ? " folder" : ""}${ticked ? " ticked" : ""}`}>
                      {ticked ? <Check size={20} /> : folder ? <Folder size={20} /> : fileIcon(item)}
                    </span>
                    <span className="row-text">
                      <span className="row-title">{item.name}</span>
                      {!folder && (
                        <span className="row-sub">
                          {syncing?.file_id === item.id
                            ? syncing.phase === "uploading"
                              ? "Uploading…"
                              : "Downloading…"
                            : `${formatBytes(item.size_bytes)} · ${formatDate(item.updated_at)}`}
                        </span>
                      )}
                    </span>
                  </button>
                  <button className="icon-btn" aria-label={`More for ${item.name}`} onClick={() => setActing(item)}>
                    <EllipsisVertical size={20} />
                  </button>
                </div>
              );
            })}
        </div>
        {!isIOS && !selecting && <AddButton label="Add to this folder" disabled={!here || progress !== null} onClick={() => setAdding(true)} />}
      </div>

      <Sheet open={adding} onClose={() => setAdding(false)} title="Add to this folder">
        <div className="panel">
          <button className="row" style={{ minHeight: 56 }} onClick={() => void chooseFiles()}>
            <FilePlus size={20} color="var(--accent-text)" />
            <span className="row-title" style={{ flex: 1 }}>Files from this phone</span>
          </button>
          <button className="row divide" style={{ minHeight: 56 }} onClick={() => void takePhoto()}>
            <Camera size={20} color="var(--accent-text)" />
            <span className="row-text">
              <span className="row-title">Take a photo</span>
              <span className="row-sub">Goes into the silo, not the gallery</span>
            </span>
          </button>
          <button className="row divide" style={{ minHeight: 56 }} onClick={() => { setAdding(false); setNaming(true); }}>
            <FolderPlus size={20} color="var(--accent-text)" />
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
        <button className="btn secondary" onClick={() => acting && void startMove([acting])}>
          Move to another folder
        </button>
        <button
          className="btn secondary"
          onClick={() => {
            if (acting) setSelected(new Map([[acting.id, acting]]));
            setActing(null);
          }}
        >
          Select several
        </button>
        <button className="btn danger" onClick={() => acting && void trash(acting)}>
          Move to trash
        </button>
      </Sheet>

      <Sheet
        open={moving !== null}
        onClose={() => setMoving(null)}
        title={moving && moving.length === 1 ? `Move ${moving[0]!.name}` : `Move ${moving?.length ?? 0} items`}
      >
        {folders === null ? (
          <p className="hint">Reading the folders…</p>
        ) : (
          <div className="panel" style={{ maxHeight: "50vh", overflowY: "auto" }}>
            {destinations.map((f, i) => {
              const depth = f.path === "/" ? 0 : f.path.split("/").length - 1;
              return (
                <button key={f.id} className={`row${i ? " divide" : ""}`} style={{ minHeight: 52, paddingLeft: 16 + depth * 16 }} onClick={() => void moveTo(f)}>
                  <Folder size={18} color="var(--accent-text)" />
                  <span className="row-title" style={{ flex: 1 }}>{f.path === "/" ? siloName : f.name}</span>
                </button>
              );
            })}
          </div>
        )}
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
