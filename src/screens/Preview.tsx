import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatBytes } from "../shared/format";
import type { FileEntry } from "../shared/types";
import { formatAppError } from "../shared/errors";
import { Sheet, TopBar, useToast } from "../ui/chrome";
import { fileDate, fileIcon } from "./Files";

type Kind = "image" | "text" | "pdf" | "other";

const TEXT_LIMIT = 2 * 1024 * 1024;

// Decided by type first and extension second: a photo imported without a
// type still has a name that says what it is.
function kindOf(file: FileEntry): Kind {
  const mime = file.mime_type ?? "";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp"].includes(ext)) {
    return "image";
  }
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("text/") || ["txt", "md", "csv", "json", "log"].includes(ext)) {
    return file.size_bytes <= TEXT_LIMIT ? "text" : "other";
  }
  return "other";
}

type Shown =
  | { at: "loading" }
  | { at: "image" }
  | { at: "text"; text: string }
  | { at: "pdf"; pages: number }
  | { at: "failed"; message: string };

export function Preview({ file, onBack }: { file: FileEntry; onBack: () => void }) {
  const kind = kindOf(file);
  const url = api.fileUrl(file.id);
  const [shown, setShown] = useState<Shown>({ at: "loading" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const toast = useToast();
  // Pages drawn at the screen's real pixel width, so text stays sharp.
  const pageWidth = Math.min(2400, Math.round(window.innerWidth * (window.devicePixelRatio || 1)));

  useEffect(() => {
    if (kind !== "pdf") return;
    let cancelled = false;
    fetch(api.pdfPagesUrl(file.id))
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setShown({ at: "failed", message: await response.text() });
          return;
        }
        const { pages } = (await response.json()) as { pages: number };
        setShown({ at: "pdf", pages });
      })
      .catch(() => !cancelled && setShown({ at: "failed", message: "This PDF could not be opened." }));
    return () => {
      cancelled = true;
    };
  }, [kind, file.id]);

  const openWith = async () => {
    setConfirmOpen(false);
    try {
      await api.openWith(file.id);
    } catch (e) {
      toast(formatAppError(e));
    }
  };

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
      <TopBar
        onBack={onBack}
        title={file.name}
        right={
          <button className="icon-btn" aria-label="Open with another app" onClick={() => setConfirmOpen(true)}>
            <ExternalLink size={22} />
          </button>
        }
      />
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
          {kind === "pdf" && shown.at === "pdf" && (
            <div style={{ position: "absolute", inset: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
              {Array.from({ length: shown.pages }, (_, i) => (
                <img
                  key={i}
                  src={api.pdfPageUrl(file.id, i, pageWidth)}
                  alt={`Page ${i + 1} of ${shown.pages}`}
                  loading="lazy"
                  style={{ width: "100%", borderRadius: 6, background: "#fff", minHeight: 120 }}
                />
              ))}
            </div>
          )}
          {kind === "other" && placeholder("This kind of file can't be shown here. Open it with another app from the top right.")}
          {kind !== "other" && shown.at === "loading" && placeholder("Decrypting…")}
          {shown.at === "failed" && placeholder(shown.message)}
        </div>
        <div className="muted" style={{ fontSize: "0.88rem", textAlign: "center" }}>
          {formatBytes(file.size_bytes)} · modified {fileDate(file.updated_at)}
        </div>
      </div>

      <Sheet open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Open with another app">
        <p className="hint">
          The other app gets this file unencrypted and may keep its own copy. SilentSilo removes its copy when you come back to
          it.
        </p>
        <button className="btn" onClick={() => void openWith()}>
          Open
        </button>
        <button className="btn secondary" onClick={() => setConfirmOpen(false)}>
          Cancel
        </button>
      </Sheet>
    </div>
  );
}
