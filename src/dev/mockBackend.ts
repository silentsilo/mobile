import type { PasswordEntry, SecurityKeyInfo } from "../shared/types";

/**
 * A stand-in for the Rust side, so every screen can be opened in a browser or
 * on a phone before the real flows are wired. Development only, behind
 * `?mock` (or VITE_MOCK=1); `?mock=locked` and `?mock=unlocked` skip the join.
 */

type Handler = (args: Record<string, unknown>) => unknown;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const scenario = new URLSearchParams(location.search).get("mock") ?? import.meta.env.VITE_MOCK_SCENARIO ?? "";

let joined = scenario === "locked" || scenario === "unlocked";
let unlocked = scenario === "unlocked";
let lockAfter = 30;
let screenOff = true;
let backup = {
  vaultId: "",
  photos: false,
  contacts: false,
  wifiOnly: true,
  chargingOnly: false,
  sent: 0,
  lastRun: 0,
  lastError: "",
  photosAllowed: false,
  contactsAllowed: false,
  remind: true,
  waiting: 0,
  videos: false,
  videosAllowed: false,
  folders: [] as string[],
};
let phoneKey = joined;

const silo = {
  id: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
  name: "Personal",
  path: "",
  last_opened: Math.floor(Date.now() / 1000),
  present: true,
  unlocked: true,
};
const meta = () => ({ revision: 42, vault_id: silo.id });
const ROOT = "00000000-0000-0000-0000-0000000000ff";

const now = Date.now();
const entry = (id: string, service: string, username: string, url: string, extra: Partial<PasswordEntry> = {}): PasswordEntry => ({
  id,
  service,
  username,
  password: "k7Tq9mRzLv4ePx2Wn8Hc",
  url,
  notes: "",
  category: "General",
  created_at: now,
  updated_at: now,
  ...extra,
});

let entries: PasswordEntry[] = [
  entry("e1", "GitHub", "you@example.com", "https://github.com", { totp_secret: "JBSWY3DPEHPK3PXP" }),
  entry("e2", "Hetzner Cloud", "you@example.com", "https://console.hetzner.cloud"),
  entry("e3", "Home router", "admin", "http://192.168.1.1"),
  entry("e4", "Namecheap", "you-example", "https://namecheap.com"),
  entry("e5", "Nextcloud", "you", "https://cloud.example.com"),
  entry("e6", "Proton Mail", "you@proton.me", "https://mail.proton.me"),
  entry("e7", "Revolut", "+40 7xx xxx xxx", "https://revolut.com"),
];

// A security key "arrives" 2 s after it is asked for, unless cancelled.
let keyWait: ((reason: string) => void) | null = null;
const keyTouch = () =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      keyWait = null;
      resolve();
    }, 2000);
    keyWait = (reason) => {
      clearTimeout(timer);
      keyWait = null;
      reject(reason);
    };
  });

let keys: SecurityKeyInfo[] = [
  { kind: "fido2", credential_id: "05c18a6f", public_key: "3059", key_slot: 1, rp_id: "silentsilo.com", label: "YubiKey 5 NFC", wrapped_dek: "ef", platform: false },
  { kind: "fido2", credential_id: "9d02b7e1", public_key: "3059", key_slot: 2, rp_id: "silentsilo.com", label: "Office PC", wrapped_dek: "ef", platform: true },
];
if (phoneKey) {
  keys.unshift({ kind: "android-keystore", credential_id: "a1b2c3d4", public_key: "04", key_slot: 3, rp_id: "silentsilo.com", label: "Pixel 8", wrapped_dek: "ef", platform: true });
}

const folder = (id: string, name: string, path: string) => ({
  kind: "folder", id, parent_id: ROOT, name, path, created_at: 1756900000, updated_at: 1756900000, favorite: false,
});
const file = (id: string, name: string, size: number, mime: string, at: number) => ({
  kind: "file", id, folder_id: ROOT, name, blob_id: `b-${id}`, size_bytes: size, mime_type: mime, content_hash: null, created_at: at, updated_at: at, favorite: false,
});

const normalized = (code: unknown) => String(code ?? "").replace(/[^0-9a-z]/gi, "");

// Failure scenarios for the device check: ?mock&nobio, &nolock, &oldandroid,
// &nokeystore, &oldwebview, &lowspace, &tee.
const flag = (name: string) => new URLSearchParams(location.search).has(name);

const handlers: Record<string, Handler> = {
  device_check: async () => {
    await wait(300);
    return {
      android_release: flag("oldandroid") ? "11" : "16",
      android_supported: !flag("oldandroid"),
      secure_lock: !flag("nolock"),
      strong_biometric: !flag("nobio"),
      keystore: flag("nokeystore") ? "failed" : flag("tee") ? "tee" : "strongbox",
      webview_version: flag("oldwebview") ? "91.0.4472.114" : "140.0.7339.51",
      webview_ok: !flag("oldwebview"),
      free_bytes: flag("lowspace") ? 200_000_000 : 64_000_000_000,
    };
  },

  app_bootstrap: () => ({
    provisioned: joined,
    locked: joined && !unlocked,
    fido_available: true,
    fido_key_present: true,
    fido_enrolled: phoneKey,
    fido_backup_enrolled: false,
    platform_authenticator: true,
    portable_enrolled: false,
    platform_enrolled: phoneKey,
    silo: joined ? { ...silo, unlocked } : null,
  }),

  sftp_probe_host_key: async () => {
    await wait(500);
    return "SHA256:k3Hq9vR2mX0pLw7tYc4NfBz8dJ1eUa6sGo5iVh2KqTc";
  },
  vault_preview_join: async (args) => {
    await wait(700);
    const c = args.config as { bucket?: string; url?: string; host?: string };
    if ((c.bucket ?? c.url ?? c.host ?? "").includes("empty")) return { vault_id: null, key_labels: [] };
    return { vault_id: silo.id, key_labels: ["YubiKey 5 NFC", "Office PC"] };
  },
  vault_join_with_recovery: async (args) => {
    await wait(900);
    if (normalized(args.code).length !== 32) throw "That recovery code does not open this silo.";
    joined = true;
    unlocked = true;
    phoneKey = false;
    silo.name = String(args.name || "Personal");
    return meta();
  },
  device_key_enroll: async (args) => {
    await wait(900);
    phoneKey = true;
    keys = [{ kind: "android-keystore", credential_id: "a1b2c3d4", public_key: "04", key_slot: 3, rp_id: "silentsilo.com", label: String(args.label), wrapped_dek: "ef", platform: true }, ...keys];
  },

  vault_unlock: async () => {
    await wait(700);
    unlocked = true;
    return meta();
  },
  vault_unlock_with_recovery: async (args) => {
    await wait(700);
    if (normalized(args.code).length !== 32) throw "That recovery code does not open this silo.";
    unlocked = true;
    return meta();
  },
  security_key_status: () => ({ nfc: true, nfcOn: true, usb: true }),
  security_key_count: () => keys.filter((k) => (k.kind ?? "fido2") === "fido2" && !k.platform).length,
  security_key_cancel: () => {
    keyWait?.("Cancelled");
  },
  vault_unlock_with_security_key: async () => {
    await keyTouch();
    unlocked = true;
    return meta();
  },
  security_key_enroll: async (args) => {
    await keyTouch();
    if (!args.pin) throw "This security key asks for its PIN.";
    if (args.pin !== "1234") throw "Wrong PIN.";
    keys = [...keys, { kind: "fido2", credential_id: crypto.randomUUID(), public_key: "3059", key_slot: 4, rp_id: "silentsilo.com", label: String(args.label || "Security key"), wrapped_dek: "ef", platform: false }];
  },
  vault_lock: () => {
    unlocked = false;
  },

  vault_read_passwords: () => JSON.stringify(entries),
  vault_upsert_password: (args) => {
    const next = JSON.parse(String(args.json)) as PasswordEntry;
    entries = entries.some((e) => e.id === next.id) ? entries.map((e) => (e.id === next.id ? next : e)) : [...entries, next];
  },
  vault_delete_password: (args) => {
    entries = entries.filter((e) => e.id !== args.id);
  },
  copy_secret_to_clipboard: () => undefined,

  vault_root_folder: () => ({ id: ROOT, parent_id: null, name: "root", path: "/", created_at: 0, updated_at: 0, favorite: false }),
  vault_list_folder: (args) =>
    String(args.folderId) === ROOT
      ? [
          folder("f1", "Documents", "/Documents"),
          folder("f2", "Photos", "/Photos"),
          folder("f3", "Taxes 2025", "/Taxes 2025"),
          file("g1", "car-insurance.jpg", 2_400_000, "image/jpeg", 1756857600),
          file("g2", "lease-agreement.pdf", 880_000, "application/pdf", 1755129600),
          file("g3", "passport-scan.pdf", 1_200_000, "application/pdf", 1751414400),
        ]
      : [],

  sync_status: () => ({ configured: true, pending_ops: 0, archive_targets: 0 }),
  sync_now: async () => {
    await wait(800);
    return { configured: true, ops_pushed: 0, ops_fetched: 0, blobs_uploaded: 0, blobs_failed: 0, needs_rebuild: false, needs_rejoin: false, skipped: false };
  },

  fido_list_keys: () => keys,
  fido_remove_key: (args) => {
    keys = keys.filter((k) => k.credential_id !== args.credentialId);
    return { withheld: [] };
  },
  recovery_status: () => ({ enabled: true, created_at: 1769000000 }),
  backup_status: () => backup,
  backup_configure: async (args) => {
    await wait(400);
    const settings = args.settings as Record<string, boolean>;
    backup = { ...backup, ...settings, vaultId: settings.photos || settings.contacts ? silo.id : "", photosAllowed: true, contactsAllowed: true };
    return backup;
  },
  files_pick: () => [{ uri: "content://mock/1", name: "Scan.pdf", size: 120000, mimeType: "application/pdf" }],
  files_take_shared: () => [],
  files_take_photo: () => null,
  vault_import_offered: async () => {
    await wait(300);
    return {};
  },
  vault_create_folder: (args) => ({ id: crypto.randomUUID(), name: args.name }),
  share_to_inbox: async () => {
    await wait(300);
  },
  vault_rename_file: (args) => ({ id: args.fileId, name: args.newName }),
  vault_rename_folder: (args) => ({ id: args.folderId, name: args.newName }),
  vault_trash_file: () => undefined,
  vault_trash_folder: () => undefined,
  vault_list_trash: () => [],
  vault_restore_file: () => ({}),
  vault_restore_folder: () => ({}),
  vault_purge_trash: () => 0,
  silo_list: () => [
    { id: silo.id, name: silo.name, active: true, unlocked },
    { id: "5a5a5a5a-0000-4000-8000-000000000002", name: "Work", active: false, unlocked: false },
  ],
  silo_switch: () => undefined,
  silo_remove: () => undefined,
  device_name: () => "Pixel 10 Pro",
  autofill_status: () => ({ supported: true, enabled: false }),
  autofill_enable: () => undefined,
  backup_waiting: () => (backup.photos || backup.contacts ? 3 : null),
  backup_media_folders: () => [
    { id: "1", name: "Camera", photos: 41200, videos: 1320, bytes: 230 * 1024 ** 3 },
    { id: "2", name: "Screenshots", photos: 5210, videos: 12, bytes: 6 * 1024 ** 3 },
    { id: "3", name: "WhatsApp Images", photos: 1803, videos: 0, bytes: 2 * 1024 ** 3 },
  ],
  backup_run_now: () => {
    backup = { ...backup, lastRun: Math.floor(Date.now() / 1000) };
  },
  lock_after_get: () => lockAfter,
  lock_on_screen_off_get: () => screenOff,
  lock_on_screen_off_set: (args) => {
    screenOff = Boolean(args.on);
  },
  lock_after_set: (args) => {
    lockAfter = Number(args.seconds);
  },
  "plugin:event|listen": () => 1,
  "plugin:event|unlisten": () => undefined,
};

export function installMockBackend() {
  const w = window as unknown as Record<string, unknown>;
  let nextListener = 1;
  w.__TAURI_INTERNALS__ = {
    // A 2x2 PNG for every file, so the preview has something real to decode.
    convertFileSrc: () =>
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVQI12P8z8DAwMDAxMDAwMDAAAANHQEDOg4mPQAAAABJRU5ErkJggg==",
    metadata: { currentWebview: { label: "main", windowLabel: "main" }, currentWindow: { label: "main" } },
    invoke: (cmd: string, args: Record<string, unknown> = {}) => {
      const handler = handlers[cmd];
      if (!handler) {
        console.warn(`[mock] no handler for ${cmd}`);
        return Promise.reject(`[mock] ${cmd} is not mocked`);
      }
      return Promise.resolve().then(() => handler(args));
    },
    transformCallback: (cb: unknown) => {
      const id = nextListener++;
      w[`_${id}`] = cb;
      return id;
    },
  };
}
