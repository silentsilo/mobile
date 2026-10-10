import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import { formatBytes, formatDate } from "../shared/format";
import type { FileEntry } from "../shared/types";
import { formatAppError } from "../shared/errors";
import { Sheet, TopBar, useToast } from "../ui/chrome";
import { fileIcon } from "./Files";
import { t, useLocale } from "../i18n";

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
  useLocale();
  const kind = kindOf(file);
  const url = api.fileUrl(file.id);
  const [shown, setShown] = useState<Shown>({ at: "loading" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  // A file only in storage comes down first: how far, in bytes.
  const [download, setDownload] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    const stop = listen<{ file_id: string; done: number; total: number }>("file-download", (event) => {
      if (event.payload.file_id === file.id) setDownload(event.payload);
    });
    return () => {
      void stop.then((off) => off());
    };
  }, [file.id]);
  const downloading =
    download && download.total > 0 && download.done < download.total
      ? t("files.downloading_of", { done: formatBytes(download.done), total: formatBytes(download.total) })
      : null;
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
      .catch(() => !cancelled && setShown({ at: "failed", message: t("files.pdf_failed") }));
    return () => {
      cancelled = true;
    };
  }, [kind, file.id]);

  // A large file may have to come down from storage and be decrypted first,
  // which takes a while; without this the tap looked like it did nothing.
  const [opening, setOpening] = useState(false);
  const openWith = async () => {
    setConfirmOpen(false);
    setOpening(true);
    try {
      await api.openWith(file.id);
    } catch (e) {
      toast(formatAppError(e));
    } finally {
      setOpening(false);
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
      .catch(() => !cancelled && setShown({ at: "failed", message: t("files.file_failed") }));
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
        borderRadius: "var(--r-md)",
        border: "1px dashed var(--border-strong)",
        background: "var(--surface-2)",
        padding: 16,
        textAlign: "center",
      }}
    >
      {fileIcon(file, 40)}
      <span className="caption">{text}</span>
    </div>
  );

  return (
    <div className="screen">
      <TopBar
        onBack={onBack}
        title={file.name}
        right={
          <button className="icon-btn" aria-label={t("files.open_with")} disabled={opening} onClick={() => setConfirmOpen(true)}>
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
              onError={() => setShown({ at: "failed", message: t("files.image_failed") })}
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
                borderRadius: "var(--r-md)",
                visibility: shown.at === "image" ? "visible" : "hidden",
              }}
            />
          )}
          {kind === "text" && shown.at === "text" && (
            <pre className="panel" style={{ position: "absolute", inset: 0, margin: 0, padding: 14, overflow: "auto", whiteSpace: "pre-wrap", fontSize: "var(--fs-caption)" }}>
              {shown.text}
            </pre>
          )}
          {kind === "pdf" && shown.at === "pdf" && (
            <div style={{ position: "absolute", inset: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
              {Array.from({ length: shown.pages }, (_, i) => (
                <img
                  key={i}
                  src={api.pdfPageUrl(file.id, i, pageWidth)}
                  alt={t("files.page_of", { page: i + 1, pages: shown.pages })}
                  loading="lazy"
                  style={{ width: "100%", borderRadius: "var(--r-xs)", background: "#fff", minHeight: 120 }}
                />
              ))}
            </div>
          )}
          {kind === "other" && placeholder(t("files.cannot_preview"))}
          {kind !== "other" && shown.at === "loading" && placeholder(downloading ?? t("files.decrypting"))}
          {shown.at === "failed" && placeholder(shown.message)}
        </div>
        {opening && (
          <div className="notice" role="status">
            {downloading ?? t("files.getting_ready", { name: file.name, size: formatBytes(file.size_bytes) })}
          </div>
        )}
        <div className="muted caption" style={{ textAlign: "center" }}>
          {t("files.size_modified", { size: formatBytes(file.size_bytes), date: formatDate(file.updated_at) })}
        </div>
      </div>

      <Sheet open={confirmOpen} onClose={() => setConfirmOpen(false)} title={t("files.open_with")}>
        <p className="hint">{t("files.open_with_text")}</p>
        <button className="btn" onClick={() => void openWith()}>
          {t("files.open")}
        </button>
        <button className="btn secondary" onClick={() => setConfirmOpen(false)}>
          {t("common.cancel")}
        </button>
      </Sheet>
    </div>
  );
}
