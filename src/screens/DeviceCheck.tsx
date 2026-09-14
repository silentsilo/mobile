import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import type { DeviceCheck as Check } from "../api";

type Line = { ok: boolean | "warn"; title: string; detail: string };

// Required checks block setup; the rest only inform.
export function blockingFailures(check: Check): boolean {
  return !check.android_supported || !check.secure_lock || !check.strong_biometric || check.keystore === "failed" || !check.webview_ok;
}

function linesFor(check: Check): Line[] {
  return [
    {
      ok: check.android_supported,
      title: `Android ${check.android_release}`,
      detail: check.android_supported ? "Supported." : "SilentSilo needs Android 12 or newer, where the phone's key storage can hold the silo key.",
    },
    {
      ok: check.secure_lock,
      title: "Screen lock",
      detail: check.secure_lock ? "Set." : "Set a PIN, pattern or password in the phone's security settings first.",
    },
    {
      ok: check.strong_biometric,
      title: "Fingerprint or face",
      detail: check.strong_biometric ? "Set up." : "Add a fingerprint or face in the phone's security settings. It is what unlocks the silo.",
    },
    {
      ok: check.keystore === "failed" ? false : true,
      title: "Key storage",
      detail:
        check.keystore === "strongbox"
          ? "Tested: the key is kept in the phone's dedicated security chip."
          : check.keystore === "tee"
            ? "Tested: the key is kept in the phone's secure area. This phone has no dedicated security chip."
            : "This phone's key storage refused to make the kind of key a silo needs. It cannot hold a silo key.",
    },
    {
      ok: check.webview_ok,
      title: "Android System WebView",
      detail: check.webview_ok ? `Version ${check.webview_version}.` : `Version ${check.webview_version} is too old. Update Android System WebView from the Play Store.`,
    },
    {
      ok: check.free_bytes < 500_000_000 ? "warn" : true,
      title: "Free space",
      detail: check.free_bytes < 500_000_000 ? "Under 500 MB free. Files you open from the silo need room on the phone." : "Enough.",
    },
  ];
}

export function DeviceCheck({ check, checking, onRetry }: { check: Check; checking: boolean; onRetry: () => void }) {
  return (
    <div className="screen">
      <div className="screen-body" style={{ paddingTop: 28 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 className="title">This phone is not ready yet</h1>
          <p className="hint">SilentSilo tested what it needs on this phone. Fix what is marked below and check again.</p>
        </div>
        <div className="panel">
          {linesFor(check).map((line, i) => (
            <div key={line.title} className={`row${i > 0 ? " divide" : ""}`} style={{ alignItems: "flex-start", paddingTop: 14, paddingBottom: 14 }}>
              {line.ok === true ? (
                <CircleCheck size={22} color="var(--success)" style={{ flex: "none" }} />
              ) : line.ok === "warn" ? (
                <TriangleAlert size={22} color="var(--warning)" style={{ flex: "none" }} />
              ) : (
                <CircleX size={22} color="var(--danger-on-dark)" style={{ flex: "none" }} />
              )}
              <span className="row-text" style={{ gap: 3 }}>
                <span style={{ fontWeight: 650 }}>{line.title}</span>
                <span className="hint small" style={{ whiteSpace: "normal" }}>{line.detail}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="spacer" />
        <button className="btn" onClick={onRetry} disabled={checking}>
          {checking ? "Checking" : "Check again"}
        </button>
      </div>
    </div>
  );
}
