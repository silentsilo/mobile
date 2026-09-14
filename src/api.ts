import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { isCategoriesRow } from "./shared/passwordUtil";
import type {
  Bootstrap,
  FileEntry,
  FolderEntry,
  PasswordEntry,
  RecoveryStatus,
  SecurityKeyInfo,
  VaultEntry,
  VaultMeta,
} from "./shared/types";

// Command names and argument shapes are the desktop's, so the flows can move
// into core without the screens changing.

export type StoreConfigInput =
  | {
      kind: "s3";
      endpoint: string;
      region: string;
      bucket: string;
      prefix: string;
      accessKeyId: string;
      secretAccessKey: string | null;
      pathStyle: boolean;
    }
  | { kind: "web-dav"; url: string; username: string; password: string | null }
  | {
      kind: "sftp";
      host: string;
      port: number;
      username: string;
      path: string;
      auth: { method: "password"; password: string | null };
      hostFingerprint: string | null;
    };

export type JoinPreview = { vault_id: string | null; key_labels: string[] };

/** Measured by doing each operation on the phone, not read from the model. */
export type DeviceCheck = {
  android_release: string;
  android_supported: boolean;
  secure_lock: boolean;
  strong_biometric: boolean;
  keystore: "strongbox" | "tee" | "failed";
  webview_version: string;
  webview_ok: boolean;
  free_bytes: number;
};

export type SyncStatus = { configured: boolean; pending_ops: number; archive_targets: number };

export type SyncReport = {
  configured: boolean;
  ops_pushed: number;
  ops_fetched: number;
  blobs_uploaded: number;
  blobs_failed: number;
  needs_rebuild: boolean;
  needs_rejoin: boolean;
  skipped: boolean;
};

export type BackupStatus = {
  vaultId: string;
  photos: boolean;
  contacts: boolean;
  wifiOnly: boolean;
  chargingOnly: boolean;
  sent: number;
  lastRun: number;
  lastError: string;
  photosAllowed: boolean;
  contactsAllowed: boolean;
  remind: boolean;
  waiting: number;
};

export type BackupSettings = {
  photos: boolean;
  contacts: boolean;
  wifiOnly: boolean;
  chargingOnly: boolean;
  includeExisting: boolean;
  remind: boolean;
};

/** A file on the phone or offered by another app, not read yet. */
export type Offered = { uri: string; name: string; size: number; mimeType: string };

export const api = {
  bootstrap: () => invoke<Bootstrap>("app_bootstrap"),
  deviceCheck: () => invoke<DeviceCheck>("device_check"),

  probeHostKey: (host: string, port: number) => invoke<string>("sftp_probe_host_key", { host, port }),
  previewJoin: (config: StoreConfigInput) => invoke<JoinPreview>("vault_preview_join", { config }),
  joinWithRecovery: (config: StoreConfigInput, code: string, name: string) =>
    invoke<VaultMeta>("vault_join_with_recovery", { config, code, name, location: null }),
  enrollDeviceKey: (label: string) => invoke<void>("device_key_enroll", { label }),

  unlock: () => invoke<VaultMeta>("vault_unlock"),
  unlockWithRecovery: (code: string) => invoke<VaultMeta>("vault_unlock_with_recovery", { code }),
  lock: () => invoke<void>("vault_lock", { id: null }),
  lockAfter: () => invoke<number>("lock_after_get"),
  setLockAfter: (seconds: number) => invoke<void>("lock_after_set", { seconds }),

  readPasswords: async (): Promise<PasswordEntry[]> => {
    const rows = JSON.parse(await invoke<string>("vault_read_passwords")) as unknown[];
    return rows.filter((row) => !isCategoriesRow(row)) as PasswordEntry[];
  },
  upsertPassword: (entry: PasswordEntry) =>
    invoke<void>("vault_upsert_password", { id: entry.id, json: JSON.stringify(entry) }),
  deletePassword: (id: string) => invoke<void>("vault_delete_password", { id }),
  copySecret: (text: string) => invoke<void>("copy_secret_to_clipboard", { text }),

  rootFolder: () => invoke<FolderEntry>("vault_root_folder"),
  listFolder: (folderId: string) => invoke<VaultEntry[]>("vault_list_folder", { folderId }),
  /** Where a file's decrypted bytes are served, for an image or a fetch. */
  fileUrl: (fileId: string) => convertFileSrc(fileId, "silo"),
  /** A PDF's page count, and each page drawn as an image. */
  pdfPagesUrl: (fileId: string) => `${convertFileSrc("", "silo")}pdf/${fileId}/pages`,
  pdfPageUrl: (fileId: string, page: number, width: number) => `${convertFileSrc("", "silo")}pdf/${fileId}/${page}?w=${width}`,
  openWith: (fileId: string) => invoke<void>("file_open_with", { fileId }),

  syncStatus: () => invoke<SyncStatus>("sync_status"),
  syncNow: () => invoke<SyncReport>("sync_now"),

  listKeys: () => invoke<SecurityKeyInfo[]>("fido_list_keys"),
  removeKey: (credentialId: string) => invoke<unknown>("fido_remove_key", { credentialId }),
  recoveryStatus: () => invoke<RecoveryStatus>("recovery_status"),

  backupStatus: () => invoke<BackupStatus>("backup_status"),
  configureBackup: (settings: BackupSettings) => invoke<BackupStatus>("backup_configure", { settings }),
  runBackupNow: () => invoke<void>("backup_run_now"),
  pickFiles: () => invoke<Offered[]>("files_pick"),
  takeShared: () => invoke<Offered[]>("files_take_shared"),
  takePhoto: () => invoke<string | null>("files_take_photo"),
  importOffered: (file: Offered, folderId: string) => invoke<FileEntry>("vault_import_offered", { file, folderId }),
  importPhoto: (path: string, name: string, folderId: string) => invoke<FileEntry>("vault_import_photo", { path, name, folderId }),
  createFolder: (parentId: string, name: string) => invoke<FolderEntry>("vault_create_folder", { parentId, name }),
  shareToInbox: (file: Offered) => invoke<void>("share_to_inbox", { file }),

  backupWaiting: () => invoke<number | null>("backup_waiting"),
  photoCount: () => invoke<{ count: number; bytes: number }>("backup_photo_count"),
};
