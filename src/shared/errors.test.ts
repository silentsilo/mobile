import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasKey, setLanguage } from "../i18n";
import { decodeAppError, formatAppError, plainError } from "./errors";

const SEP = "\u001f";

beforeEach(() => setLanguage("en"));
afterEach(() => setLanguage("system"));

describe("formatAppError", () => {
  it("says a full disk in words, on every platform", () => {
    for (const raw of [
      "No space left on device (os error 28)",
      "There is not enough space on the disk. (os error 112)",
    ]) {
      expect(formatAppError(raw)).toContain("storage is full");
    }
    expect(formatAppError("failed (os error 280)")).not.toContain("storage is full");
  });

  it("says a missing backup storage in the phone's words", () => {
    const expected = "Not backed up. This silo is only on this phone.";
    expect(formatAppError("CloudNotConfigured")).toBe(expected);
    expect(formatAppError("That file is not on this phone, and no backup storage is connected.")).toBe(expected);
  });

  it("maps a cancelled or timed-out key prompt, and only a key prompt", () => {
    expect(formatAppError("user_cancelled")).toBe("The key prompt was cancelled.");
    expect(formatAppError("Biometric prompt cancelled")).toBe("The key prompt was cancelled.");
    expect(formatAppError("Security key request timed out")).toBe("The key prompt timed out. Try again.");
    expect(formatAppError("request timed out")).toBe(
      "Your backup storage did not answer in time. Check your connection and try again.",
    );
  });

  it("strips the Kotlin plugin's code prefix", () => {
    expect(formatAppError("[no_nfc] - This phone has no NFC.")).toBe("This phone has no NFC.");
  });

  it("falls back to a generic message for empty or missing input", () => {
    expect(formatAppError("")).toBe("Something went wrong.");
    expect(formatAppError(null)).toBe("Unknown error");
    expect(formatAppError(undefined)).toBe("Unknown error");
  });

  it("speaks the language in use", () => {
    setLanguage("ro");
    expect(formatAppError("CloudNotConfigured")).toBe("Fără backup. Acest siloz există doar pe acest telefon.");
  });
});

describe("coded backend errors", () => {
  it("are said by their key, with their values", () => {
    expect(formatAppError(`That key was not found.${SEP}err.key_not_found`)).toBe("That key was not found.");
    const taken = `You already have a silo called “Work”.${SEP}err.silo_name_taken${SEP}{"name":"Work"}`;
    expect(decodeAppError(taken)).toEqual({
      message: "You already have a silo called “Work”.",
      code: "err.silo_name_taken",
      params: { name: "Work" },
    });
    expect(formatAppError(taken)).toBe("You already have a silo called “Work”.");
    setLanguage("de");
    expect(formatAppError(taken)).toContain("„Work“");
  });

  it("are translated behind the Kotlin prefix too", () => {
    expect(formatAppError(`[x] - That key was not found.${SEP}err.key_not_found`)).toBe("That key was not found.");
  });

  it("fall back to their English when this build has no text for the key", () => {
    expect(formatAppError(`Something new.${SEP}err.not_in_this_build`)).toBe("Something new.");
  });

  it("leave plain strings as they were", () => {
    expect(decodeAppError("cancelled")).toEqual({ message: "cancelled", code: null, params: {} });
  });

  it("lose their keys inside a list the backend built", () => {
    expect(plainError(`a.txt: Not a file.${SEP}err.not_a_file; b: x${SEP}err.y${SEP}{"p":"1"}`)).toBe(
      "a.txt: Not a file.; b: x",
    );
  });

  it("have a text for every key the backend sends", () => {
    // This app's backend, and core's crates when its checkout sits beside
    // this one (a developer's machine; CI has only the pinned tag).
    // Vite reads the options as written, so they cannot be shared in a constant.
    const sources = {
      ...import.meta.glob<string>("../../src-tauri/src/**/*.rs", {
        query: "?raw",
        import: "default",
        eager: true,
      }),
      ...import.meta.glob<string>("../../../silentsilo.core/crates/*/src/**/*.rs", {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    };
    const codes = new Set<string>();
    for (const text of Object.values(sources)) {
      for (const m of text.matchAll(/coded!\(\s*"(err\.[\w.]+)"/g)) codes.add(m[1]!);
      for (const m of text.matchAll(/coded_with\(\s*"(err\.[\w.]+)"/g)) codes.add(m[1]!);
      for (const m of text.matchAll(/\\u\{1f\}(err\.[\w.]+)/g)) codes.add(m[1]!);
    }
    expect(Object.keys(sources).length).toBeGreaterThan(0);
    if (Object.keys(sources).some((file) => file.includes("silentsilo.core"))) {
      expect(codes.size).toBeGreaterThan(5);
    }
    expect([...codes].filter((code) => !hasKey(code))).toEqual([]);
  });
});
