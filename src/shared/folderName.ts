// Copied from silentsilo/desktop src/lib/cloud.ts (folderNameFor); keep in step.

/** The folder name when there is no silo name to go by. */
export const DEFAULT_FOLDER = "Silo";

/**
 * A new copy's folder starts with the silo's name, so someone with several
 * silos can tell their folders apart at the provider and gets the same name
 * back when setting a silo up from one. The hint under the field says the
 * provider sees it. Made into a name every provider takes: the characters
 * OneDrive refuses become "-", no dot or space at either end.
 */
export function folderNameFor(siloName: string): string {
  const name = siloName
    // eslint-disable-next-line no-control-regex
    .replace(/["*:<>?/\\|\u0000-\u001f\u007f]/g, "-")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 100)
    .trim();
  return name || DEFAULT_FOLDER;
}

/** A name for the silo being set up, from the folder or bucket it is in:
 * the silo's own name is not kept in storage, and the folder usually is it. */
export function siloNameFromStorage(config: { kind: string } & Record<string, unknown>): string {
  const last = (path: unknown) =>
    String(path ?? "")
      .split("/")
      .filter(Boolean)
      .pop() ?? "";
  switch (config.kind) {
    case "s3":
      return last(config.prefix) || String(config.bucket ?? "");
    case "web-dav":
      return last(config.url);
    case "sftp":
      return last(config.path) || String(config.host ?? "");
    default:
      return String(config.folder ?? "");
  }
}
