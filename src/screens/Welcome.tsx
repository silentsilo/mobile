import { Cloud, LockKeyhole, ScanFace } from "lucide-react";
import icon from "../assets/icon.svg";
import { t, useLocale } from "../i18n";

export function Welcome({ onStart, onCreate }: { onStart: () => void; onCreate: () => void }) {
  useLocale();
  const needs = [
    { Icon: Cloud, text: t("start.welcome_need_storage") },
    { Icon: LockKeyhole, text: t("start.welcome_need_code") },
    { Icon: ScanFace, text: t("start.welcome_need_biometric") },
  ];
  return (
    <div className="screen">
      <div className="screen-body" style={{ paddingTop: 28, gap: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <img src={icon} alt="" width={44} height={44} style={{ borderRadius: "22%", display: "block" }} />
          <span className="brand">SilentSilo</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h1 className="title display">{t("start.welcome_title")}</h1>
          <p className="hint">{t("start.welcome_body")}</p>
        </div>
        <div className="panel">
          <div className="label" style={{ padding: "16px 16px 4px" }}>
            {t("start.welcome_needs")}
          </div>
          {needs.map(({ Icon, text }, i) => (
            <div key={text} className={`row${i > 0 ? " divide" : ""}`}>
              <Icon size={22} color="var(--accent-text)" />
              <span className="small">{text}</span>
            </div>
          ))}
        </div>
        <div className="spacer" />
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <button className="btn" onClick={onStart}>
            {t("start.join")}
          </button>
          <button className="btn secondary" onClick={onCreate}>
            {t("start.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
