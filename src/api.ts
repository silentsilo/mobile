import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { isCategoriesRow } from "./shared/passwordUtil";
import type {
  Bootstrap,
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

  syncStatus: () => invoke<SyncStatus>("sync_status"),
  syncNow: () => invoke<SyncReport>("sync_now"),

  listKeys: () => invoke<SecurityKeyInfo[]>("fido_list_keys"),
  removeKey: (credentialId: string) => invoke<unknown>("fido_remove_key", { credentialId }),
  recoveryStatus: () => invoke<RecoveryStatus>("recovery_status"),
};
