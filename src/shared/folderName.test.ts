import { describe, expect, it } from "vitest";
import { folderNameFor, siloNameFromStorage } from "./folderName";

describe("folderNameFor", () => {
  it("keeps a plain silo name and makes any other one usable", () => {
    expect(folderNameFor("Personal")).toBe("Personal");
    expect(folderNameFor("Work: 2026/Q1")).toBe("Work- 2026-Q1");
    expect(folderNameFor("...")).toBe("Silo");
  });
});

describe("siloNameFromStorage", () => {
  it("names the silo after the folder or bucket it is in", () => {
    expect(siloNameFromStorage({ kind: "icloud", folder: "Family" })).toBe("Family");
    expect(siloNameFromStorage({ kind: "onedrive", signIn: null, folder: "Work" })).toBe("Work");
    expect(siloNameFromStorage({ kind: "s3", bucket: "vault", prefix: "silos/home" })).toBe("home");
    expect(siloNameFromStorage({ kind: "s3", bucket: "vault", prefix: "" })).toBe("vault");
    expect(siloNameFromStorage({ kind: "web-dav", url: "https://dav.example.com/backups/Personal/" })).toBe("Personal");
    expect(siloNameFromStorage({ kind: "sftp", host: "nas", path: "" })).toBe("nas");
  });
});
