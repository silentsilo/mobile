# Contributing to SilentSilo mobile

Thanks for considering a contribution. This repository holds the Android and
iOS applications. The engine, the persisted formats and the cryptography
live in [silentsilo/core](https://github.com/silentsilo/core); the desktop
application in [silentsilo/desktop](https://github.com/silentsilo/desktop).

## Contributor License Agreement

Contributions are accepted under the terms of [CLA.md](CLA.md). Opening a
pull request constitutes acceptance; you keep the copyright to your work.
Please read it once before your first PR. It is short and written to be
readable.

## The rule that matters most

Nothing in this repository may change what a silo writes to disk or to
storage. A change like that belongs in core, where the compatibility
fixtures run against it, and reaches this app only through a new core tag.
