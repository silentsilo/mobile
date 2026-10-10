import { api, type Offered } from "../api";
import { formatAppError } from "./errors";
import { t } from "../i18n";

/** Adds each file in turn, and says how it went in one sentence. */
export async function addAll(files: Offered[], folderId: string, onProgress: (done: number) => void): Promise<string> {
  let added = 0;
  let lastError = "";
  // The screen stays on and a lock waits, so a long import is not cut half way.
  await api.setBusy(true).catch(() => {});
  try {
    for (const [i, file] of files.entries()) {
      onProgress(i);
      try {
        await api.importOffered(file, folderId);
        added++;
      } catch (e) {
        lastError = `${file.name}: ${formatAppError(e)}`;
      }
    }
  } finally {
    await api.setBusy(false).catch(() => {});
  }
  onProgress(files.length);
  const summary = t("pw.files_added", { count: added });
  return lastError ? `${summary} ${t("pw.files_not_added", { count: files.length - added })} ${lastError}` : summary;
}

/** "Photo 2026-09-14 15.42.07.jpg", in the phone's time. */
export function photoName(now = new Date()) {
  const two = (n: number) => String(n).padStart(2, "0");
  return `Photo ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}.jpg`;
}
