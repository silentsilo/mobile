import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Probe = { app_version: string; key_bytes: number };

// First build only: shows that the core crates linked and ran on the phone.
export default function App() {
  const [probe, setProbe] = useState<Probe | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<Probe>("probe").then(setProbe, (e) => setError(String(e)));
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        boxSizing: "border-box",
        padding: "calc(env(safe-area-inset-top) + 32px) 24px 24px",
        background: "linear-gradient(180deg, #0a0e1a 0%, #05070d 100%)",
        color: "#f8fafc",
        fontFamily: '"Plus Jakarta Sans Variable", system-ui, sans-serif',
      }}
    >
      <h1 style={{ margin: 0, fontWeight: 700, fontSize: "1.65rem", letterSpacing: "-0.03em" }}>
        SilentSilo
      </h1>
      <p style={{ color: "#98a3c2", fontSize: "0.94rem" }}>
        {error
          ? `Core did not answer: ${error}`
          : probe
            ? `Version ${probe.app_version}. Core generated a ${probe.key_bytes}-byte key on this device.`
            : "Starting"}
      </p>
    </main>
  );
}
