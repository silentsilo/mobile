import { Check, ChevronDown, Copy, KeyRound, Paperclip, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type SyncStatus } from "../api";
import { formatAppError } from "../shared/errors";
import { avatarColor, inkOn, searchTextFor, serviceInitials, subtitleFor } from "../shared/passwordUtil";
import type { PasswordEntry } from "../shared/types";
import { AddButton, EmptyState, Notice, Sheet, Skeleton, useToast } from "../ui/chrome";
import { useBackLayer } from "../ui/back";
import { isIOS } from "../ui/platform";
import { describeProgress, useLeftOut, useSyncProgress } from "../ui/syncActivity";
import { ensureVerified } from "../ui/reverify";
import { SiloSwitcher } from "./SiloSwitcher";
import { haptic } from "../ui/haptics";
import { t, useLocale } from "../i18n";

export function SiloHeader({ siloName, sync, action }: { siloName: string; sync: SyncStatus | null; action?: React.ReactNode }) {
  useLocale();
  const waiting = sync?.pending_ops ?? 0;
  const [switching, setSwitching] = useState(false);
  const progress = useSyncProgress();
  const leftOut = useLeftOut();
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 16px 14px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        <button
          className="text-btn"
          style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: "var(--fs-headline)", letterSpacing: "-0.03em", color: "var(--ink)", padding: 0 }}
          onClick={() => setSwitching(true)}
          aria-label={t("pw.switch_silo_label", { name: siloName })}
        >
          {siloName}
          <ChevronDown size={20} color="var(--text-muted)" />
        </button>
        <SiloSwitcher open={switching} onClose={() => setSwitching(false)} />
        {sync?.configured && (
          <div className="muted caption" style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            {progress ? (
              <RefreshCw size={12} className="spin" color="var(--accent-text)" style={{ flex: "none" }} />
            ) : (
              <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "none", background: waiting || leftOut ? "var(--warning)" : "var(--success)" }} />
            )}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {progress
                ? describeProgress(progress)
                : leftOut
                  ? t("pw.not_syncing")
                  : waiting
                  ? t("pw.sync_waiting", { count: waiting })
                  : t("pw.synced")}
            </span>
          </div>
        )}
      </div>
      {action}
    </div>
  );
}

export function Passwords({
  siloName,
  sync,
  reloadKey,
  onOpen,
  onAdd,
}: {
  siloName: string;
  sync: SyncStatus | null;
  reloadKey: number;
  onOpen: (entry: PasswordEntry) => void;
  onAdd: () => void;
}) {
  const [entries, setEntries] = useState<PasswordEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  useLocale();

  useEffect(() => {
    api.readPasswords().then(
      (rows) => setEntries([...rows].sort((a, b) => a.service.localeCompare(b.service))),
      (e) => setError(formatAppError(e)),
    );
  }, [reloadKey]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (entries ?? []).filter((e) => !q || searchTextFor(e).includes(q));
  }, [entries, query]);

  // A long press ticks an entry, as in Files; then a tap ticks or unticks,
  // and the bar at the top deletes what is ticked.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const selecting = selected.size > 0;
  useBackLayer(selecting, () => setSelected(new Set()));
  const pressTimer = useRef<number | undefined>(undefined);
  const pressed = useRef(false);
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pressProps = (id: string) => ({
    onPointerDown: () => {
      pressed.current = false;
      window.clearTimeout(pressTimer.current);
      pressTimer.current = window.setTimeout(() => {
        pressed.current = true;
        haptic("heavy");
        toggle(id);
      }, LONG_PRESS_MS);
    },
    onPointerUp: () => window.clearTimeout(pressTimer.current),
    onPointerLeave: () => window.clearTimeout(pressTimer.current),
    onPointerCancel: () => window.clearTimeout(pressTimer.current),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });
  const tap = (entry: PasswordEntry) => {
    if (pressed.current) {
      pressed.current = false;
      return;
    }
    if (selecting) toggle(entry.id);
    else onOpen(entry);
  };

  const deleteSelected = async () => {
    const going = (entries ?? []).filter((e) => selected.has(e.id));
    haptic("heavy");
    setDeleting(true);
    try {
      for (const entry of going) await api.deletePassword(entry);
      setEntries((prev) => (prev ?? []).filter((e) => !selected.has(e.id)));
      toast(t("pw.bulk_deleted", { count: going.length }));
      setSelected(new Set());
    } catch (e) {
      toast(formatAppError(e));
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const copyPassword = async (entry: PasswordEntry) => {
    try {
      await ensureVerified(entry);
      await api.copySecret(entry, entry.password, "password");
      haptic("confirm");
      toast(t("pw.password_copied"));
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {selecting ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px" }}>
          <button className="icon-btn" aria-label={t("files.clear_selection")} onClick={() => setSelected(new Set())}>
            <X size={22} />
          </button>
          <span style={{ flex: 1, fontWeight: 650 }}>{t("files.selected", { count: selected.size })}</span>
          <button className="icon-btn" aria-label={t("pw.bulk_delete_label")} onClick={() => setConfirmDelete(true)}>
            <Trash2 size={22} />
          </button>
        </div>
      ) : (
        <SiloHeader
          siloName={siloName}
          sync={sync}
          action={isIOS ? <AddButton label={t("pw.new_entry")} onClick={onAdd} /> : undefined}
        />
      )}
      <div style={{ padding: "0 16px 10px" }}>
        <div className="input">
          <Search size={20} color="var(--text-dim)" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={entries ? t("pw.search_count", { count: entries.length }) : t("pw.search")}
            aria-label={t("pw.search_label")}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </div>
      </div>
      <div className="list-area">
        <div className="list-scroll">
          {error && <Notice tone="error" style={{ margin: 16 }}>{error}</Notice>}
          {!entries && !error && <Skeleton />}
          {entries && shown.length === 0 &&
            (query ? (
              <EmptyState icon={<Search size={26} />} title={t("pw.no_matches")} hint={t("pw.no_matches_hint")} />
            ) : (
              <EmptyState
                icon={<KeyRound size={26} />}
                title={t("pw.empty_title")}
                hint={t("pw.empty_hint")}
                action={{ label: t("pw.add_password"), onClick: onAdd }}
              />
            ))}
          {shown.map((entry) => {
            const bg = avatarColor(entry.service);
            const ticked = selected.has(entry.id);
            return (
              <div key={entry.id} className="row split divide">
                <button
                  className="row-main"
                  aria-pressed={selecting ? ticked : undefined}
                  onClick={() => tap(entry)}
                  {...pressProps(entry.id)}
                >
                  {ticked ? (
                    <span className="tile ticked">
                      <Check size={20} />
                    </span>
                  ) : (
                    <span className="avatar" style={{ background: bg, color: inkOn(bg) }}>
                      {serviceInitials(entry.service)}
                    </span>
                  )}
                  <span className="row-text">
                    <span className="row-title">
                      {entry.service}
                      {(entry.attachments ?? []).length > 0 && (
                        <Paperclip
                          size={14}
                          aria-label={t("pw.has_attachments")}
                          style={{ marginLeft: 6, verticalAlign: -2, color: "var(--text-dim)" }}
                        />
                      )}
                    </span>
                    <span className="row-sub">{subtitleFor(entry)}</span>
                  </span>
                </button>
                <button className="icon-btn" aria-label={t("pw.copy_password_of", { name: entry.service })} onClick={() => copyPassword(entry)}>
                  <Copy size={20} />
                </button>
              </div>
            );
          })}
        </div>
        {!isIOS && !selecting && <AddButton label={t("pw.new_entry")} onClick={onAdd} />}
      </div>

      <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title={t("pw.bulk_delete_title", { count: selected.size })}>
        <p className="hint">
          {sync?.configured ? t("pw.bulk_delete_synced") : t("pw.bulk_delete_local")} {t("pw.delete_no_trash")}
          {sync?.configured && sync.archive_targets > 0 && ` ${t("pw.delete_archive")}`}
        </p>
        <button className="btn danger" aria-busy={deleting} disabled={deleting} onClick={() => void deleteSelected()}>
          {t("pw.bulk_delete_button", { count: selected.size })}
        </button>
        <button className="btn secondary" disabled={deleting} onClick={() => setConfirmDelete(false)}>
          {t("common.cancel")}
        </button>
      </Sheet>
    </div>
  );
}

const LONG_PRESS_MS = 450;
