import { api } from "../api";
import type { PasswordEntry } from "../shared/types";

/** How long one confirmation covers an entry, as on desktop. */
const GRACE_MS = 3 * 60_000;

const verifiedAt = new Map<string, number>();

/**
 * Asks for the fingerprint again before a protected entry's secrets show or
 * copy. Resolves true for an entry that does not ask, or one confirmed in
 * the last few minutes; rejects with the prompt's error otherwise.
 */
export async function ensureVerified(entry: PasswordEntry): Promise<boolean> {
  if (entry.require_reauth !== true) return true;
  const last = verifiedAt.get(entry.id);
  if (last !== undefined && Date.now() - last < GRACE_MS) return true;
  await api.reverify();
  verifiedAt.set(entry.id, Date.now());
  return true;
}

/** Whether a protected entry was confirmed recently enough to show as is. */
export function recentlyVerified(entry: PasswordEntry): boolean {
  if (entry.require_reauth !== true) return true;
  const last = verifiedAt.get(entry.id);
  return last !== undefined && Date.now() - last < GRACE_MS;
}

/** Forgets every confirmation, for a lock. */
export function forgetVerified(): void {
  verifiedAt.clear();
}
