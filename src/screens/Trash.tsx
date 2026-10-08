import { Folder, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type SyncStatus } from "../api";
import { formatAppError } from "../shared/errors";
import { formatBytes } from "../shared/format";
import type { TrashItem } from "../shared/types";
import { EmptyState, Notice, Sheet, Skeleton, TopBar, useToast } from "../ui/chrome";
import { fileIcon } from "./Files";
import { haptic } from "../ui/haptics";
import { t, useLocale } from "../i18n";

/** Said before a purge: the app never deletes from a never-delete copy. */
function archiveNote(archiveTargets: number): string {
  if (archiveTargets === 0) return "";
  return ` ${t("files.archive_note", { count: archiveTargets })}`;
}

export function Trash({ sync, onBack }: { sync: SyncStatus | null; onBack: () => void }) {
  useLocale();
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
      <TopBar onBack={onBack} backLabel={t("files.back_silo")} />
      <div className="screen-body tight" style={{ gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
          <h1 className="title">{t("files.trash_title")}</h1>
          <p className="hint">{t("files.trash_hint")}</p>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {!items && !error && <Skeleton avatar={false} rows={4} />}
        {items?.length === 0 && (
          <EmptyState icon={<Trash2 size={26} />} title={t("files.trash_empty_title")} hint={t("files.trash_empty_hint")} />
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
            {t("files.empty_trash")}
          </button>
        )}
      </div>

      <Sheet open={chosen !== null} onClose={() => setChosen(null)} title={chosen?.name}>
        {chosen && (
          <>
            <p className="hint">{t("files.purge_warning")}{archiveNote(sync?.archive_targets ?? 0)}</p>
            <button
              className="btn secondary"
              onClick={() =>
                void act(() => (chosen.kind === "folder" ? api.restoreFolder(chosen.id) : api.restoreFile(chosen.id)), t("files.restored_one"))
              }
            >
              <RotateCcw size={18} />
              {t("files.restore")}
            </button>
            <button className="btn danger" onClick={() => {
                haptic("heavy");
                void act(() => api.purgeTrash([chosen.id]), t("files.deleted_for_good"));
              }}>
              {t("files.delete_for_good")}
            </button>
          </>
        )}
      </Sheet>

      <Sheet open={emptying} onClose={() => setEmptying(false)} title={t("files.empty_trash_title")}>
        <p className="hint">
          {t("files.empty_trash_text")}
          {archiveNote(sync?.archive_targets ?? 0)}
        </p>
        <button className="btn danger" onClick={() => {
            haptic("heavy");
            void act(() => api.purgeTrash([]), t("files.trash_emptied"));
          }}>
          {t("files.empty_trash")}
        </button>
        <button className="btn secondary" onClick={() => setEmptying(false)}>
          {t("common.cancel")}
        </button>
      </Sheet>
    </div>
  );
}
