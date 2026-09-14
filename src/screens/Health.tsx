import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { analyseHealth, type HealthFinding } from "../shared/health";
import { subtitleFor } from "../shared/passwordUtil";
import type { PasswordEntry } from "../shared/types";
import { TopBar } from "../ui/chrome";

const COLOUR: Record<HealthFinding["severity"], string> = {
  high: "var(--danger)",
  medium: "var(--warning)",
  info: "var(--text-dim)",
};

/** What is wrong with the silo's passwords and setup, worked out on this
 * phone from what is already open. Nothing is sent anywhere. */
export function Health({ onBack, onOpen }: { onBack: () => void; onOpen: (entry: PasswordEntry) => void }) {
  const [findings, setFindings] = useState<HealthFinding[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.readPasswords(), api.syncStatus(), api.listKeys(), api.recoveryStatus()])
      .then(([entries, sync, keys, recovery]) =>
        setFindings(
          analyseHealth(entries, {
            backupConfigured: sync.configured,
            securityKeyCount: keys.length,
            recoveryCodeSet: recovery.enabled,
            // A phone's free space is not the silo's problem worth a finding.
            freeBytes: null,
            headroomBytes: 0,
          }),
        ),
      )
      .catch((e) => setError(formatAppError(e)));
  }, []);

  return (
    <div className="screen">
      <TopBar onBack={onBack} backLabel="Silo" />
      <div className="screen-body tight" style={{ gap: 14 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
          <h1 className="title">Password health</h1>
          <p className="hint">Checked on this phone. No password leaves it for this.</p>
        </div>
        {error && <div className="notice error">{error}</div>}
        {findings?.length === 0 && <div className="notice">Nothing to fix. Every password is unique and strong.</div>}
        {findings?.map((finding) => {
          const expanded = open === finding.id;
          return (
            <div key={finding.id} className="panel">
              <button className="row" style={{ minHeight: 64, alignItems: "flex-start", paddingTop: 14 }} onClick={() => setOpen(expanded ? null : finding.id)}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: COLOUR[finding.severity], marginTop: 6, flex: "none" }} />
                <span className="row-text">
                  <span className="row-title">{finding.title}</span>
                  <span className="row-sub" style={{ whiteSpace: "normal" }}>{finding.detail}</span>
                </span>
                {finding.entries.length > 0 && (expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} color="var(--text-dim)" />)}
              </button>
              {expanded &&
                (finding.groups ?? [finding.entries]).map((group, g) => (
                  <div key={g} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                    {group.map((entry) => (
                      <button key={entry.id} className="row divide" style={{ paddingLeft: 40 }} onClick={() => onOpen(entry)}>
                        <span className="row-text">
                          <span className="row-title">{entry.service}</span>
                          <span className="row-sub">{subtitleFor(entry)}</span>
                        </span>
                        <ChevronRight size={18} color="var(--text-dim)" />
                      </button>
                    ))}
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
