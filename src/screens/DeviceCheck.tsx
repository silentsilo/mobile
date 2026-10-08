import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import type { DeviceCheck as Check } from "../api";
import { t, useLocale } from "../i18n";

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
      detail: check.android_supported ? t("start.check_android_ok") : t("start.check_android_fail"),
    },
    {
      ok: check.secure_lock,
      title: t("start.check_lock"),
      detail: check.secure_lock ? t("start.check_lock_ok") : t("start.check_lock_fail"),
    },
    {
      ok: check.strong_biometric,
      title: t("start.check_biometric"),
      detail: check.strong_biometric ? t("start.check_biometric_ok") : t("start.check_biometric_fail"),
    },
    {
      ok: check.keystore === "failed" ? false : true,
      title: t("start.check_keystore"),
      detail:
        check.keystore === "strongbox"
          ? t("start.check_keystore_strongbox")
          : check.keystore === "tee"
            ? t("start.check_keystore_tee")
            : t("start.check_keystore_failed"),
    },
    {
      ok: check.webview_ok,
      title: "Android System WebView",
      detail: check.webview_ok
        ? t("start.check_webview_ok", { version: check.webview_version })
        : t("start.check_webview_fail", { version: check.webview_version }),
    },
    {
      ok: check.free_bytes < 500_000_000 ? "warn" : true,
      title: t("start.check_space"),
      detail: check.free_bytes < 500_000_000 ? t("start.check_space_low") : t("start.check_space_ok"),
    },
  ];
}

export function DeviceCheck({ check, checking, onRetry }: { check: Check; checking: boolean; onRetry: () => void }) {
  useLocale();
  return (
    <div className="screen">
      <div className="screen-body" style={{ paddingTop: 28 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 className="title">{t("start.check_title")}</h1>
          <p className="hint">{t("start.check_body")}</p>
        </div>
        <div className="panel">
          {linesFor(check).map((line, i) => (
            <div key={line.title} className={`row${i > 0 ? " divide" : ""}`} style={{ alignItems: "flex-start", paddingTop: 14, paddingBottom: 14 }}>
              {line.ok === true ? (
                <CircleCheck size={22} color="var(--success)" style={{ flex: "none" }} />
              ) : line.ok === "warn" ? (
                <TriangleAlert size={22} color="var(--warning)" style={{ flex: "none" }} />
              ) : (
                <CircleX size={22} color="var(--danger-text)" style={{ flex: "none" }} />
              )}
              <span className="row-text" style={{ gap: 3 }}>
                <span style={{ fontWeight: 650 }}>{line.title}</span>
                <span className="hint small" style={{ whiteSpace: "normal" }}>{line.detail}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="spacer" />
        <button className="btn" aria-busy={checking} onClick={onRetry} disabled={checking}>
          {checking ? t("start.checking") : t("start.check_again")}
        </button>
      </div>
    </div>
  );
}
