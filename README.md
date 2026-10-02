# SilentSilo mobile

The Android and iOS clients of [SilentSilo](https://silentsilo.com), a
local-first encrypted vault for files and passwords. AGPL-3.0.

**Android** 12 or later: [Google Play](https://play.google.com/store/apps/details?id=com.silentsilo.mobile).
**iOS**: not started, no date.

The engine lives in [silentsilo/core](https://github.com/silentsilo/core).
This repository pins a tag from it, the same way
[silentsilo/desktop](https://github.com/silentsilo/desktop) does. Persisted
formats are defined in core and never here, so a silo opened on a phone is
the same silo the desktop opens, and `silentsilo-extract` reads what a phone
wrote.

## What a phone does

A phone creates a silo of its own or sets up one that already exists from
the backup storage that silo syncs to (OneDrive, Dropbox, Google Drive, an
S3 bucket, WebDAV or SFTP). It unlocks with a key held in the phone's own
hardware (Android Keystore, StrongBox where the phone has it) behind its
fingerprint, or with a security key over NFC or USB. The recovery code opens the silo when every key is gone.

On Android it also fills logins in other apps through the system autofill,
acts as a passkey provider for browsers, and can back up photos, videos and
contacts, encrypted on the phone, once you turn that on.

> **No independent security audit has been done.** The cryptography is
> specified in core's `docs/CRYPTO.md` and the formats in its `FORMATS.md`.
> That makes the design reviewable; it is not the same as an audit.

## Licence

AGPL-3.0-or-later, see [LICENSE](LICENSE). Contributions are accepted under
[CLA.md](CLA.md), identical in all three SilentSilo repositories.
