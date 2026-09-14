use silentsilo_app::{AppEvent, Host};
use silentsilo_vault::BackupTarget;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

/// What core asks of this app: the desktop's event names, stderr for
/// diagnostics, and the storage settings saved at join.
pub struct MobileHost(pub AppHandle);

impl Host for MobileHost {
    fn emit(&self, event: AppEvent) {
        let _ = match event {
            AppEvent::SyncReport(report) => self.0.emit("sync-report", report),
            AppEvent::VaultChanged => self.0.emit("vault-changed", ()),
            AppEvent::SyncProgress(progress) => self.0.emit("sync-progress", progress),
        };
    }

    fn warn(&self, area: &str, detail: &str) {
        eprintln!("[{area}] {detail}");
    }

    fn targets(&self, silo_id: Uuid) -> Vec<BackupTarget> {
        silentsilo_vault::load_targets(silo_id)
    }
}
