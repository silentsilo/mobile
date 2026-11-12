import type { SyncReport } from "../api";
import { formatAppError } from "../shared/errors";
import { t } from "../i18n";
import { copyTrouble } from "./syncActivity";

/** The one line a finished pass is worth, or null when the silo's own card
 * already says it (a phone that fell behind gets a rebuild button there). */
export function syncSay(report: SyncReport): string | null {
  if (report.needs_rejoin)
    return t(report.rotation_unproven ? "silo.sync_left_out_unproven" : "silo.sync_left_out");
  if ((report.chain_holes?.length ?? 0) > 0) return t("silo.sync_records_missing");
  if (report.needs_rebuild) return null;
  if (report.key_material_replaced) return t("silo.sync_key_replaced");
  if (report.skipped) return t("silo.sync_already_running");
  if (report.error) return t("silo.sync_error", { reason: formatAppError(report.error) });
  const copies = report.targets ?? [];
  const trouble = copyTrouble(report, Date.now());
  // No copy answered: nothing was checked, so nothing is "up to date".
  if (copies.length > 0 && report.reached === 0)
    return trouble ?? t("start.copy_unreachable_soon", { label: t("start.copy_backup_storage") });
  if (report.needs_update) return t("silo.sync_needs_update");
  if (report.blobs_failed > 0) return t("silo.sync_files_failed", { count: report.blobs_failed });
  if (trouble) return `${t("silo.sync_done")} ${trouble}`;
  const imported = report.inbox_imported ?? 0;
  if (imported > 0) return t("silo.sync_imported", { count: imported });
  return report.ops_pushed + report.ops_fetched > 0 ? t("silo.sync_done") : t("silo.sync_up_to_date");
}
