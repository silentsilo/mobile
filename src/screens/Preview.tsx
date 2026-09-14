import { useEffect, useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { formatBytes } from "../shared/format";
import type { FileEntry } from "../shared/types";
import { TopBar } from "../ui/chrome";
import { fileDate, fileIcon } from "./Files";

type Kind = "image" | "text" | "other";

const TEXT_LIMIT = 2 * 1024 * 1024;

// Decided by type first and extension second: a photo imported without a
// type still has a name that says what it is.
function kindOf(file: FileEntry): Kind {
  const mime = file.mime_type ?? "";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "heic", "avif", "bmp"].includes(ext)) {
    return "image";
  }
  if (mime.startsWith("text/") || ["txt", "md", "csv", "json", "log"].includes(ext)) {
    return file.size_bytes <= TEXT_LIMIT ? "text" : "other";
  }
  return "other";
}

type Shown = { at: "loading" } | { at: "image"; url: string } | { at: "text"; text: string } | { at: "failed"; message: string };

export function Preview({ file, onBack }: { file: FileEntry; onBack: () => void }) {
  const kind = kindOf(file);
  const [shown, setShown] = useState<Shown>({ at: "loading" });

  useEffect(() => {
    if (kind === "other") return;
    let url: string | null = null;
    let cancelled = false;
    api.readFile(file.id).then(
      (bytes) => {
        if (cancelled) return;
        if (kind === "image") {
          url = URL.createObjectURL(new Blob([bytes], { type: file.mime_type ?? "image/*" }));
          setShown({ at: "image", url });
        } else {
          setShown({ at: "text", text: new TextDecoder().decode(bytes) });
        }
      },
      (e) => !cancelled && setShown({ at: "failed", message: formatAppError(e) }),
    );
    // The decrypted image lives only as long as this screen does.
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.id, file.mime_type, kind]);

  return (
    <div className="screen">
      <TopBar onBack={onBack} title={file.name} />
      <div className="screen-body tight" style={{ gap: 16 }}>
        {kind === "image" && shown.at === "image" ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
            <img src={shown.url} alt={file.name} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: "var(--radius)" }} />
          </div>
        ) : kind === "text" && shown.at === "text" ? (
          <pre className="panel" style={{ flex: 1, margin: 0, padding: 14, overflow: "auto", whiteSpace: "pre-wrap", fontSize: "0.85rem" }}>
            {shown.text}
          </pre>
        ) : (
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
              padding: 16,
              textAlign: "center",
            }}
          >
            {fileIcon(file, 40)}
            <span style={{ fontSize: "0.85rem" }}>
              {kind === "other"
                ? "This kind of file can't be shown here yet."
                : shown.at === "failed"
                  ? shown.message
                  : "Decrypting…"}
            </span>
          </div>
        )}
        <div className="muted" style={{ fontSize: "0.88rem", textAlign: "center" }}>
          {formatBytes(file.size_bytes)} · modified {fileDate(file.updated_at)}
        </div>
      </div>
    </div>
  );
}
