# SilentSilo mobile

The Android and iOS clients of [SilentSilo](https://silentsilo.com), a
local-first encrypted vault for files and passwords. AGPL-3.0.

**Android** 12 or later: [Google Play](https://play.google.com/store/apps/details?id=com.silentsilo.mobile).
**iOS** 17 or later, iPhone only: in progress, no date. It unlocks with Face ID or a security key over NFC, fills logins through AutoFill, takes files from other apps' share sheet and backs up photos and contacts in the background.

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

Passwords carry custom fields and their earlier versions, as on the
desktop, and a password autofill replaces stays in the entry's history.

A silo's activity log records on the phone too: unlocking, secrets shown
or copied, files opened, and changes to entries, files, keys and the
recovery code. It is on by default, turned off under Silo, Activity log,
and read on a computer. Filling with autofill and passkeys are not recorded
yet: the person picks the login in Android's own list, which the app does
not see.

On Android it also fills logins in other apps through the system autofill,
acts as a passkey provider for browsers, and can back up photos, videos and
contacts, encrypted on the phone, once you turn that on.

On the iPhone the same, without passkeys for now. AutoFill is an extension
iOS runs apart from the app (`autofill/`, `gen/apple/AutoFill/`): it opens
the silo with Face ID in a scratch folder of its own, lists its logins and
closes it again without writing to it. Silos live in the app group's
container so the extension can read them. Backup runs when iOS lets it,
usually at night on the charger; there is no schedule to promise.

The app speaks English, Romanian, German, French, Spanish, Italian,
Brazilian Portuguese and Polish, chosen under Silo, Language, or following
the phone. What Android shows itself (autofill, passkeys, notifications)
follows the phone's language. Every text has a note for translators in
`src/i18n/screens/`, and the terms follow the desktop app's glossary.

> **No independent security audit has been done.** The cryptography is
> specified in core's `docs/CRYPTO.md` and the formats in its `FORMATS.md`.
> That makes the design reviewable; it is not the same as an audit.

## Licence

Copyright (C) 2026 Software Hive S.R.L.

AGPL-3.0-or-later, see [LICENSE](LICENSE). Contributions are accepted under
[CLA.md](CLA.md), identical in all four SilentSilo repositories.
