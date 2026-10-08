import { Cloud, LockKeyhole, ScanFace } from "lucide-react";
import icon from "../assets/icon.svg";

export function Welcome({ onStart, onCreate }: { onStart: () => void; onCreate: () => void }) {
  const needs = [
    { Icon: Cloud, text: "The details of your silo's backup storage" },
    { Icon: LockKeyhole, text: "Your recovery code" },
    { Icon: ScanFace, text: "A fingerprint or face set up on this phone" },
  ];
  return (
    <div className="screen">
      <div className="screen-body" style={{ paddingTop: 28, gap: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <img src={icon} alt="" width={44} height={44} style={{ borderRadius: "22%", display: "block" }} />
          <span className="brand">SilentSilo</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h1 className="title display">
            Open your silo on this phone
          </h1>
          <p className="hint">
            Set up a silo you already have from its backup storage, or make a new one here.
            The silo is encrypted on this phone, and your fingerprint or face unlocks it.
          </p>
        </div>
        <div className="panel">
          <div className="label" style={{ padding: "16px 16px 4px" }}>
            What you need
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
            Set up from backup storage
          </button>
          <button className="btn secondary" onClick={onCreate}>
            Make a new silo
          </button>
        </div>
      </div>
    </div>
  );
}
