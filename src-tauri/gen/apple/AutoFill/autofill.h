// What the AutoFill extension calls in Rust (`autofill/src/lib.rs`).
#pragma once

// Opens the silo with Face ID and lists its logins: JSON, `{logins}` or
// `{error}`. Free the answer with ss_af_free.
char *ss_af_logins(const char *data_dir, const char *work_dir);
// Wipes and frees an answer.
void ss_af_free(char *text);
