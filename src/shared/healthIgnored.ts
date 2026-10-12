// From silentsilo/desktop src/views/health/ignored.ts, except that what is
// stored here is a digest of each finding, not the finding itself.
import type { HealthFinding } from "./health";

/**
 * Health findings the person chose to ignore, per silo, on this phone.
 * Only what is not critical can be ignored. A finding is remembered as it
 * was: the kind and the entries it named. One that grows, a fourth stale
 * password where there were three, is a new finding and shows again.
 *
 * The page's storage sits on the phone outside the silo, so it keeps only a
 * SHA-256 of each finding: which entries were grouped together stays inside
 * the silo.
 */

const KEY = (siloId: string) => `silentsilo.health.ignored.${siloId}`;

const DIGEST = /^[0-9a-f]{64}$/;

/** The finding as it was: its kind and the entries it named. */
function plainFingerprint(finding: HealthFinding): string {
  const ids = finding.entries.map((e) => e.id).sort();
  return `${finding.id}:${ids.join(",")}`;
}

async function digest(siloId: string, plain: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${siloId}\n${plain}`),
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What is stored for a finding. */
export function fingerprint(siloId: string, finding: HealthFinding): Promise<string> {
  return digest(siloId, plainFingerprint(finding));
}

export function canIgnore(finding: HealthFinding): boolean {
  return finding.severity !== "high";
}

/** The stored choices. A list written before digests were kept is turned
 * into digests and written back. */
export async function loadIgnored(siloId: string): Promise<Set<string>> {
  let list: string[] = [];
  try {
    const raw = window.localStorage.getItem(KEY(siloId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    list = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return new Set();
  }
  if (list.every((v) => DIGEST.test(v))) return new Set(list);
  const converted = new Set(
    await Promise.all(list.map((v) => (DIGEST.test(v) ? v : digest(siloId, v)))),
  );
  saveIgnored(siloId, converted);
  return converted;
}

export function saveIgnored(siloId: string, ignored: Set<string>): void {
  try {
    window.localStorage.setItem(KEY(siloId), JSON.stringify([...ignored]));
  } catch {
    // Private storage off: the choice lasts until the app closes.
  }
}

/** A silo removed from this phone leaves nothing of its own behind. */
export function forgetIgnored(siloId: string): void {
  try {
    window.localStorage.removeItem(KEY(siloId));
  } catch {
    // Nothing stored, or storage off.
  }
}

/** The findings to act on, and those set aside. A critical one is never
 * set aside, whatever was stored. `keys` holds each finding's digest. */
export function splitIgnored(
  findings: HealthFinding[],
  ignored: Set<string>,
  keys: ReadonlyMap<HealthFinding, string>,
): { active: HealthFinding[]; ignored: HealthFinding[] } {
  const active: HealthFinding[] = [];
  const aside: HealthFinding[] = [];
  for (const finding of findings) {
    const key = keys.get(finding);
    if (canIgnore(finding) && key !== undefined && ignored.has(key)) aside.push(finding);
    else active.push(finding);
  }
  return { active, ignored: aside };
}
