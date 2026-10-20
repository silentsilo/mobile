import { ImageUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { qrFromPicture, qrFromSource } from "../shared/qrImage";
import { useBackLayer } from "./back";
import { haptic } from "./haptics";
import { t, useLocale } from "../i18n";

/** How often a camera frame is read. Enough to feel instant, little enough
 *  to leave the phone cool. */
const EVERY_MS = 300;

/**
 * The camera, full screen, until a QR code is read. Frames are read on the
 * phone and never kept; the camera stops the moment the screen closes. A
 * picture from the phone works too, for a code shown on the phone itself.
 * `onCode` gets the text of the code; the caller decides whether it is a
 * two-factor one. `fromPicture` says the text came from a picture file,
 * which may still be in the gallery.
 */
export function QrScanner({
  onCode,
  onClose,
}: {
  onCode: (text: string, fromPicture: boolean) => void;
  onClose: () => void;
}) {
  useLocale();
  useBackLayer(true, onClose);
  const video = useRef<HTMLVideoElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let reading = false;
    let stopped = false;

    const tick = async () => {
      const v = video.current;
      if (stopped || done.current || reading || !v || v.readyState < 2 || !v.videoWidth) return;
      reading = true;
      try {
        const text = await qrFromSource(v, v.videoWidth, v.videoHeight);
        if (text && !done.current && !stopped) {
          done.current = true;
          haptic("confirm");
          onCode(text, false);
        }
      } catch {
        // A frame that fails is followed by the next one.
      } finally {
        reading = false;
      }
    };

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play().catch(() => undefined);
        }
        timer = window.setInterval(() => void tick(), EVERY_MS);
      })
      .catch(() => setProblem(t("pw.totp_camera_denied")));
    if (!navigator.mediaDevices) setProblem(t("pw.totp_camera_denied"));

    return () => {
      stopped = true;
      window.clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [onCode]);

  const pick = async (file: File) => {
    try {
      const text = await qrFromPicture(file);
      if (!text) {
        setProblem(t("pw.totp_qr_none"));
        return;
      }
      done.current = true;
      onCode(text, true);
    } catch {
      setProblem(t("pw.totp_qr_unreadable"));
    }
  };

  return (
    <div className="qr-scanner" role="dialog" aria-label={t("pw.totp_scan_title")}>
      <video ref={video} className="qr-video" playsInline muted autoPlay />
      <div className="qr-frame" aria-hidden />
      <div className="qr-top">
        <button className="icon-btn qr-close" aria-label={t("common.cancel")} onClick={onClose}>
          <X size={24} />
        </button>
      </div>
      <div className="qr-bottom">
        <p className="qr-say" role="status">
          {problem ?? t("pw.totp_scan_hint")}
        </p>
        <button className="btn secondary" onClick={() => picker.current?.click()}>
          <ImageUp size={20} aria-hidden />
          {t("pw.totp_scan_picture")}
        </button>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void pick(file);
          }}
        />
      </div>
    </div>
  );
}
