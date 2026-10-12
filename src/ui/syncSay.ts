import type { SyncReport } from "../api";
import { t } from "../i18n";

/** The one line a finished pass is worth, or null when the silo's own card
 * already says it (a phone that fell behind gets a rebuild button there). */
export function syncSay(report: SyncReport): string | null {
  if (report.needs_rejoin)
    return t(report.rotation_unproven ? "silo.sync_left_out_unproven" : "silo.sync_left_out");
  if ((report.chain_holes?.length ?? 0) > 0) return t("silo.sync_records_missing");
  if (report.needs_rebuild) return null;
  if (report.key_material_replaced) return t("silo.sync_key_replaced");
  if (report.skipped) return t("silo.sync_already_running");
  if (report.blobs_failed > 0) return t("silo.sync_files_failed", { count: report.blobs_failed });
  return report.ops_pushed + report.ops_fetched > 0 ? t("silo.sync_done") : t("silo.sync_up_to_date");
}
