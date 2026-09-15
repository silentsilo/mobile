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
          <h1 className="title" style={{ fontSize: "2rem" }}>
            Open your silo on this phone
          </h1>
          <p className="hint">
            Join a silo you already have, from the storage it backs up to, or make a new one here.
            Everything stays encrypted, and the phone unlocks it with your fingerprint or face.
          </p>
        </div>
        <div className="panel">
          <div className="label" style={{ padding: "16px 16px 4px" }}>
            What you need
          </div>
          {needs.map(({ Icon, text }, i) => (
            <div key={text} className={`row${i > 0 ? " divide" : ""}`}>
              <Icon size={22} color="var(--accent-hover)" />
              <span style={{ fontSize: "0.95rem" }}>{text}</span>
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
