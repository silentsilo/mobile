import { Check, ChevronDown, Contact, Copy, CreditCard, FolderInput, KeyRound, Paperclip, RefreshCw, Search, Star, StickyNote, TerminalSquare, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type SyncStatus } from "../api";
import { formatAppError } from "../shared/errors";
import { avatarColor, categoryLabel, inkOn, resolveCategories, searchTextFor, serviceInitials, subtitleFor } from "../shared/passwordUtil";
import { withEdits } from "../shared/passwordEntry";
import type { CredentialType, PasswordCategory, PasswordEntry } from "../shared/types";
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
  /** A new entry of a kind, in the category the list is showing. */
  onAdd: (category: string | null, type: CredentialType) => void;
}) {
  const [entries, setEntries] = useState<PasswordEntry[] | null>(null);
  const [stored, setStored] = useState<PasswordCategory[] | null>(null);
  // What the list shows: everything, the starred ones, or one category.
  const [showing, setShowing] = useState<{ kind: "all" } | { kind: "favorites" } | { kind: "category"; name: string }>({ kind: "all" });
  const [moving, setMoving] = useState(false);
  // "+" asks what kind of entry first, as desktop's Add entry does.
  const [choosingType, setChoosingType] = useState(false);
  const add = () => setChoosingType(true);
  const addCategory = showing.kind === "category" ? showing.name : null;
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  useLocale();

  useEffect(() => {
    api.readPasswordStore().then(
      (store) => {
        setEntries([...store.entries].sort((a, b) => a.service.localeCompare(b.service)));
        setStored(store.categories);
      },
      (e) => setError(formatAppError(e)),
    );
  }, [reloadKey]);

  const categories = useMemo(() => resolveCategories(stored, entries ?? []), [stored, entries]);
  const counts = useMemo(() => {
    const by = new Map<string, number>();
    for (const e of entries ?? []) by.set(e.category, (by.get(e.category) ?? 0) + 1);
    return by;
  }, [entries]);
  const starred = (entries ?? []).filter((e) => e.favorite).length;

  // A category emptied or a last star removed leaves nothing to show.
  useEffect(() => {
    if (showing.kind === "category" && !counts.get(showing.name)) setShowing({ kind: "all" });
    if (showing.kind === "favorites" && starred === 0) setShowing({ kind: "all" });
  }, [counts, showing, starred]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (entries ?? []).filter(
      (e) =>
        (showing.kind === "all" ||
          (showing.kind === "favorites" ? e.favorite : e.category === showing.name)) &&
        (!q || searchTextFor(e).includes(q)),
    );
  }, [entries, query, showing]);

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

  // One save per entry: each is its own change, as on desktop.
  const moveSelected = async (category: string) => {
    setMoving(false);
    const going = (entries ?? []).filter((e) => selected.has(e.id) && e.category !== category);
    try {
      const saved: PasswordEntry[] = [];
      for (const entry of going) saved.push(await api.savePassword(entry, withEdits(entry, { category }), "arranged"));
      const byId = new Map(saved.map((e) => [e.id, e]));
      setEntries((prev) => (prev ?? []).map((e) => byId.get(e.id) ?? e));
      toast(t("pw.bulk_moved", { count: going.length, category: categoryLabel(category) }));
      setSelected(new Set());
    } catch (e) {
      toast(formatAppError(e));
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
          <button className="icon-btn" aria-label={t("pw.bulk_move")} onClick={() => setMoving(true)}>
            <FolderInput size={22} />
          </button>
          <button className="icon-btn" aria-label={t("pw.bulk_delete_label")} onClick={() => setConfirmDelete(true)}>
            <Trash2 size={22} />
          </button>
        </div>
      ) : (
        <SiloHeader
          siloName={siloName}
          sync={sync}
          action={isIOS ? <AddButton label={t("pw.new_entry")} onClick={add} /> : undefined}
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
      {/* Every category in one row that scrolls sideways, so the list keeps
          the screen; only those with entries, and the stars when any. */}
      {entries && entries.length > 0 && (categories.length > 1 || starred > 0) && (
        <div className="chips" role="tablist" aria-label={t("pw.categories")}>
          <button className="chip" role="tab" aria-selected={showing.kind === "all"} onClick={() => setShowing({ kind: "all" })}>
            {t("pw.all_entries")}
            <span className="chip-count">{entries.length}</span>
          </button>
          {starred > 0 && (
            <button className="chip" role="tab" aria-selected={showing.kind === "favorites"} onClick={() => setShowing({ kind: "favorites" })}>
              <Star size={14} aria-hidden />
              {t("pw.favorites")}
              <span className="chip-count">{starred}</span>
            </button>
          )}
          {categories
            .filter((c) => counts.get(c.name))
            .map((c) => (
              <button
                key={c.name}
                className="chip"
                role="tab"
                aria-selected={showing.kind === "category" && showing.name === c.name}
                onClick={() => setShowing({ kind: "category", name: c.name })}
              >
                <span className="chip-dot" style={{ background: c.color }} aria-hidden />
                {categoryLabel(c.name)}
                <span className="chip-count">{counts.get(c.name)}</span>
              </button>
            ))}
        </div>
      )}
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
                action={{ label: t("pw.add_password"), onClick: add }}
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
        {!isIOS && !selecting && <AddButton label={t("pw.new_entry")} onClick={add} />}
      </div>

      <Sheet open={choosingType} onClose={() => setChoosingType(false)} title={t("pw.new_entry")}>
        <div className="panel">
          {ENTRY_KINDS.map(({ type, label, Icon }, i) => (
            <button
              key={type}
              className={`row${i > 0 ? " divide" : ""}`}
              style={{ minHeight: 56, width: "100%" }}
              onClick={() => {
                setChoosingType(false);
                onAdd(addCategory, type);
              }}
            >
              <Icon size={20} aria-hidden />
              <span className="row-text">
                <span className="row-title">{t(label)}</span>
              </span>
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet open={moving} onClose={() => setMoving(false)} title={t("pw.bulk_move")}>
        <div className="panel">
          {categories.map((c, i) => (
            <button key={c.name} className={`row${i > 0 ? " divide" : ""}`} style={{ minHeight: 52 }} onClick={() => void moveSelected(c.name)}>
              <span className="chip-dot" style={{ background: c.color }} aria-hidden />
              <span className="row-text">
                <span className="row-title">{categoryLabel(c.name)}</span>
              </span>
            </button>
          ))}
        </div>
        <button className="btn secondary" onClick={() => setMoving(false)}>
          {t("common.cancel")}
        </button>
      </Sheet>

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

const ENTRY_KINDS = [
  { type: "login", label: "pw.type_login", Icon: KeyRound },
  { type: "card", label: "pw.type_card", Icon: CreditCard },
  { type: "identity", label: "pw.type_identity", Icon: Contact },
  { type: "note", label: "pw.type_note", Icon: StickyNote },
  { type: "ssh_key", label: "pw.type_ssh_key", Icon: TerminalSquare },
] as const;
