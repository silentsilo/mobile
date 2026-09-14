import { ChevronDown, Copy, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type SyncStatus } from "../api";
import { formatAppError } from "../shared/errors";
import { hashColor, inkOn, searchTextFor, serviceInitials, subtitleFor } from "../shared/passwordUtil";
import type { PasswordEntry } from "../shared/types";
import { useToast } from "../ui/chrome";

export function SiloHeader({ siloName, sync, action }: { siloName: string; sync: SyncStatus | null; action?: React.ReactNode }) {
  const waiting = sync?.pending_ops ?? 0;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 16px 14px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: "1.5rem", letterSpacing: "-0.03em" }}>
          {siloName}
          <ChevronDown size={20} color="var(--text-muted)" />
        </div>
        {sync?.configured && (
          <div className="muted" style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "0.82rem" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: waiting ? "var(--warning)" : "var(--success)" }} />
            {waiting ? `${waiting} ${waiting === 1 ? "change" : "changes"} waiting to back up` : "Everything is backed up"}
          </div>
        )}
      </div>
      {action}
    </div>
  );
}

export function Passwords({ siloName, sync, onOpen }: { siloName: string; sync: SyncStatus | null; onOpen: (entry: PasswordEntry) => void }) {
  const [entries, setEntries] = useState<PasswordEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    api.readPasswords().then(
      (rows) => setEntries([...rows].sort((a, b) => a.service.localeCompare(b.service))),
      (e) => setError(formatAppError(e)),
    );
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (entries ?? []).filter((e) => !q || searchTextFor(e).includes(q));
  }, [entries, query]);

  const copyPassword = async (entry: PasswordEntry) => {
    try {
      await api.copySecret(entry.password);
      toast("Password copied. It clears from the clipboard after 30 seconds.");
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <SiloHeader siloName={siloName} sync={sync} />
      <div style={{ padding: "0 16px 10px" }}>
        <div className="input" style={{ background: "var(--surface-muted)" }}>
          <Search size={20} color="var(--text-dim)" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={entries ? `Search ${entries.length} entries` : "Search"}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {error && <div className="notice error" style={{ margin: 16 }}>{error}</div>}
        {entries && shown.length === 0 && (
          <p className="hint" style={{ textAlign: "center", padding: 32 }}>
            {query ? "Nothing matches that search." : "No passwords in this silo yet."}
          </p>
        )}
        {shown.map((entry) => {
          const bg = hashColor(entry.service);
          return (
            <div key={entry.id} className="row divide" style={{ paddingRight: 4 }}>
              <button
                onClick={() => onOpen(entry)}
                style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0, minHeight: 64, padding: 0, border: 0, background: "transparent", textAlign: "left", cursor: "pointer" }}
              >
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
    </div>
  );
}
