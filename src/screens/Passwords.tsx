import { ChevronDown, Copy, KeyRound, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type SyncStatus } from "../api";
import { formatAppError } from "../shared/errors";
import { avatarColor, inkOn, searchTextFor, serviceInitials, subtitleFor } from "../shared/passwordUtil";
import type { PasswordEntry } from "../shared/types";
import { AddButton, EmptyState, Notice, Skeleton, useToast } from "../ui/chrome";
import { isIOS } from "../ui/platform";
import { describeProgress, useLeftOut, useSyncProgress } from "../ui/syncActivity";
import { ensureVerified } from "../ui/reverify";
import { SiloSwitcher } from "./SiloSwitcher";
import { haptic } from "../ui/haptics";

export function SiloHeader({ siloName, sync, action }: { siloName: string; sync: SyncStatus | null; action?: React.ReactNode }) {
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
          aria-label={`${siloName}, switch silo`}
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
                  ? "Not syncing"
                  : waiting
                  ? `${waiting} ${waiting === 1 ? "change" : "changes"} waiting to sync`
                  : "Synced"}
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

  const copyPassword = async (entry: PasswordEntry) => {
    try {
      await ensureVerified(entry);
      await api.copySecret(entry, entry.password, "password");
      haptic("confirm");
      toast("Password copied. It clears from the clipboard after 45 seconds.");
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <SiloHeader
        siloName={siloName}
        sync={sync}
        action={isIOS ? <AddButton label="New entry" onClick={onAdd} /> : undefined}
      />
      <div style={{ padding: "0 16px 10px" }}>
        <div className="input">
          <Search size={20} color="var(--text-dim)" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={entries ? `Search ${entries.length} entries` : "Search"}
            aria-label="Search passwords"
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
              <EmptyState icon={<Search size={26} />} title="Nothing matches" hint="Try another word, or part of a site or username." />
            ) : (
              <EmptyState
                icon={<KeyRound size={26} />}
                title="No passwords yet"
                hint="Add one here, or import them in SilentSilo on your computer."
                action={{ label: "Add a password", onClick: onAdd }}
              />
            ))}
          {shown.map((entry) => {
            const bg = avatarColor(entry.service);
            return (
              <div key={entry.id} className="row split divide">
                <button className="row-main" onClick={() => onOpen(entry)}>
                  <span className="avatar" style={{ background: bg, color: inkOn(bg) }}>
                    {serviceInitials(entry.service)}
                  </span>
                  <span className="row-text">
                    <span className="row-title">{entry.service}</span>
                    <span className="row-sub">{subtitleFor(entry)}</span>
                  </span>
                </button>
                <button className="icon-btn" aria-label={`Copy the ${entry.service} password`} onClick={() => copyPassword(entry)}>
                  <Copy size={20} />
                </button>
              </div>
            );
          })}
        </div>
        {!isIOS && <AddButton label="New entry" onClick={onAdd} />}
      </div>
    </div>
  );
}
