import { formatBytes } from "../shared/format";
import type { FileEntry } from "../shared/types";
import { TopBar } from "../ui/chrome";
import { fileDate, fileIcon } from "./Files";

export function Preview({ file, onBack }: { file: FileEntry; onBack: () => void }) {
  return (
    <div className="screen">
      <TopBar onBack={onBack} title={file.name} />
      <div className="screen-body tight" style={{ gap: 16 }}>
        <div
          className="dim"
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            borderRadius: "var(--radius)",
            border: "1px dashed var(--border)",
            background: "var(--surface-muted)",
          }}
        >
          {fileIcon(file, 40)}
          <span style={{ fontSize: "0.85rem" }}>Shown here, inside the app</span>
        </div>
        <div className="muted" style={{ fontSize: "0.88rem", textAlign: "center" }}>
          {formatBytes(file.size_bytes)} · modified {fileDate(file.updated_at)}
        </div>
      </div>
    </div>
  );
}
