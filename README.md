# SilentSilo mobile

The Android and iOS clients of [SilentSilo](https://silentsilo.com), a
local-first encrypted vault for files and passwords. AGPL-3.0.

> **Not released.** Nothing here is built for users yet. The mobile apps
> ship after the desktop application reaches 1.1.0. Android comes first,
> iOS follows.

The engine lives in [silentsilo/core](https://github.com/silentsilo/core).
This repository pins a tag from it, the same way
[silentsilo/desktop](https://github.com/silentsilo/desktop) does. Persisted
formats are defined in core and never here, so a silo opened on a phone is
the same silo the desktop opens, and `silentsilo-extract` reads what a phone
wrote.

## What a phone does

A phone joins a silo that already exists, from the backup storage that silo
syncs to. It unlocks with a key held in the phone's own hardware, Android
Keystore or the Secure Enclave, behind the fingerprint or face the phone
already knows. The recovery code opens the silo when that key is gone.

> **No independent security audit has been done.** The cryptography is
> specified in core's `docs/CRYPTO.md` and the formats in its `FORMATS.md`.
> That makes the design reviewable; it is not the same as an audit.

## Licence

AGPL-3.0-or-later, see [LICENSE](LICENSE). Contributions are accepted under
[CLA.md](CLA.md), identical in all three SilentSilo repositories.
