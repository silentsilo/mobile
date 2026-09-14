import { useEffect, useState } from "react";
import { api } from "../api";
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
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp"].includes(ext)) {
    return "image";
  }
  if (mime.startsWith("text/") || ["txt", "md", "csv", "json", "log"].includes(ext)) {
    return file.size_bytes <= TEXT_LIMIT ? "text" : "other";
  }
  return "other";
}

type Shown = { at: "loading" } | { at: "image" } | { at: "text"; text: string } | { at: "failed"; message: string };

export function Preview({ file, onBack }: { file: FileEntry; onBack: () => void }) {
  const kind = kindOf(file);
  const url = api.fileUrl(file.id);
  const [shown, setShown] = useState<Shown>({ at: "loading" });

  // Text is fetched; an image loads itself below and reports back.
  useEffect(() => {
    if (kind !== "text") return;
    let cancelled = false;
    fetch(url)
      .then(async (response) => {
        const body = await response.text();
        if (cancelled) return;
        setShown(response.ok ? { at: "text", text: body } : { at: "failed", message: body });
      })
      .catch(() => !cancelled && setShown({ at: "failed", message: "This file could not be opened." }));
    return () => {
      cancelled = true;
    };
  }, [kind, url]);

  const placeholder = (text: string) => (
    <div
      className="dim"
      style={{
        position: "absolute",
        inset: 0,
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
      <span style={{ fontSize: "0.85rem" }}>{text}</span>
    </div>
  );

  return (
    <div className="screen">
      <TopBar onBack={onBack} title={file.name} />
      <div className="screen-body tight" style={{ gap: 16 }}>
        <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {kind === "image" && (
            <img
              src={url}
              alt={file.name}
              onLoad={() => setShown({ at: "image" })}
              onError={() => setShown({ at: "failed", message: "This image could not be shown here." })}
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
                borderRadius: "var(--radius)",
                visibility: shown.at === "image" ? "visible" : "hidden",
              }}
            />
          )}
          {kind === "text" && shown.at === "text" && (
            <pre className="panel" style={{ position: "absolute", inset: 0, margin: 0, padding: 14, overflow: "auto", whiteSpace: "pre-wrap", fontSize: "0.85rem" }}>
              {shown.text}
            </pre>
          )}
          {kind === "other" && placeholder("This kind of file can't be shown here yet.")}
          {kind !== "other" && shown.at === "loading" && placeholder("Decrypting…")}
          {shown.at === "failed" && placeholder(shown.message)}
        </div>
        <div className="muted" style={{ fontSize: "0.88rem", textAlign: "center" }}>
          {formatBytes(file.size_bytes)} · modified {fileDate(file.updated_at)}
        </div>
      </div>
    </div>
  );
}
