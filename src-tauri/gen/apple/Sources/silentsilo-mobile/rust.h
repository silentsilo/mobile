// What Swift calls in Rust (`src-tauri/src/backup.rs`, the `ios_job`
// module). Swift's own entry points for Rust are the `@_cdecl` functions.
#pragma once
#include <stdbool.h>
#include <stdint.h>

// Whether Rust knows where the app keeps its files yet.
bool ss_backup_ready(void);
// Sends one item, described as JSON: "ok", "retry: why" or "skip: why".
char *ss_backup_send(const char *item);
void ss_backup_record_sent(const char *item_id, const char *kind, const char *reference);
// What to send again, as JSON `[{kind, reference}]`.
char *ss_backup_resends(void);
void ss_backup_resolve(const char *kind, const char *reference);
// Items in the silo's inbox not imported yet, or -1.
int64_t ss_backup_waiting(void);
// Frees a string Rust returned.
void ss_rust_free(char *text);
