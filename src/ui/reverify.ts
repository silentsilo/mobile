import { api } from "../api";
import { withBaseFields } from "../shared/entryHistory";
import type { PasswordEntry } from "../shared/types";

/** How long one confirmation covers an entry, as on desktop. The Rust side
 * keeps the same window and is what holds the secrets back. */
export const VERIFY_GRACE_MS = 3 * 60_000;

/** Protected entries confirmed on this screen, whole, with when. */
const verified = new Map<string, { at: number; entry: PasswordEntry }>();

/** Whether an entry asks for the fingerprint before its secrets show. */
export function isProtected(entry: PasswordEntry): boolean {
  return entry.require_reauth === true;
}

/**
 * The entry with its secrets. A protected entry comes from the list with
 * them held back; this asks for the fingerprint, unless it was confirmed in
 * the last few minutes, and returns it whole. Rejects with the prompt's
 * error.
 */
export async function revealed(entry: PasswordEntry): Promise<PasswordEntry> {
  if (!isProtected(entry)) return entry;
  const whole = withBaseFields(JSON.parse(await api.revealPassword(entry.id)) as PasswordEntry);
  verified.set(entry.id, { at: Date.now(), entry: whole });
  return whole;
}

/** A protected entry confirmed recently enough to show as is, whole; null
 * when it has to ask again. An entry that does not ask is returned as is. */
export function recentlyVerified(entry: PasswordEntry): PasswordEntry | null {
  if (!isProtected(entry)) return entry;
  const last = verified.get(entry.id);
  if (!last || Date.now() - last.at >= VERIFY_GRACE_MS) return null;
  return last.entry.updated_at === entry.updated_at ? last.entry : null;
}

/** A protected entry saved whole while confirmed stays confirmed as saved. */
export function keepVerified(entry: PasswordEntry): void {
  const last = verified.get(entry.id);
  if (last && isProtected(entry) && !entry.secrets_withheld)
    verified.set(entry.id, { at: last.at, entry });
}

/** When the confirmation of an entry runs out, in `Date.now()` time. */
export function verifiedUntil(entry: PasswordEntry): number | null {
  const last = verified.get(entry.id);
  return last ? last.at + VERIFY_GRACE_MS : null;
}

/** The fingerprint once, before a change to several protected entries. */
export async function confirmForMany(entries: PasswordEntry[]): Promise<void> {
  if (entries.some(isProtected)) await api.reverify();
}

/** Forgets every confirmation, for a lock. */
export function forgetVerified(): void {
  verified.clear();
}
