import { Download, ExternalLink, Share2 } from "lucide-react";
import { Sheet } from "./chrome";
import { isIOS } from "./platform";
import { t, useLocale } from "../i18n";

/** How a decrypted copy leaves the silo: kept on the phone, sent to another
 * app as a file, or viewed in one. */
export type HandOverHow = "save" | "share" | "open";

/**
 * The ways a file or an attachment leaves the silo, one sheet everywhere.
 * Saving comes first: an attachment is mostly a document to keep. On iPhone
 * the system's share sheet already holds Save to Files and Open in, so it is
 * one choice there.
 */
export function HandOverSheet({
  open,
  title,
  onClose,
  onChoose,
}: {
  open: boolean;
  title?: string;
  onClose: () => void;
  onChoose: (how: HandOverHow) => void;
}) {
  useLocale();
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <p className="hint">{t("files.open_with_text")}</p>
      {isIOS ? (
        <button className="btn" onClick={() => onChoose("share")}>
          <Share2 size={20} aria-hidden />
          {t("files.share_or_save")}
        </button>
      ) : (
        <>
          <button className="btn" onClick={() => onChoose("save")}>
            <Download size={20} aria-hidden />
            {t("files.save_to_phone")}
          </button>
          <button className="btn secondary" onClick={() => onChoose("share")}>
            <Share2 size={20} aria-hidden />
            {t("files.share")}
          </button>
          <button className="btn secondary" onClick={() => onChoose("open")}>
            <ExternalLink size={20} aria-hidden />
            {t("files.open_with")}
          </button>
        </>
      )}
      <button className="btn secondary" onClick={onClose}>
        {t("common.cancel")}
      </button>
    </Sheet>
  );
}
