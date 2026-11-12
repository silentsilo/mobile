import { describe, expect, it } from "vitest";
import type { SyncReport, TargetStatus } from "../api";
import { describeProgress } from "./syncActivity";
import { syncSay } from "./syncSay";

const copy = (over: Partial<TargetStatus> = {}): TargetStatus => ({
  id: "t1",
  label: "Google Drive",
  ops_pushed: 0,
  blobs_uploaded: 0,
  failed: null,
  last_success: 0,
  retry_in: 0,
  waiting: false,
  ops_behind: 0,
  ...over,
});

const report = (over: Partial<SyncReport> = {}): SyncReport => ({
  silo_id: "s",
  configured: true,
  ops_pushed: 0,
  ops_fetched: 0,
  blobs_uploaded: 0,
  blobs_failed: 0,
  needs_rebuild: false,
  needs_rejoin: false,
  key_material_replaced: false,
  skipped: false,
  targets: [copy()],
  reached: 1,
  ...over,
});

describe("syncSay", () => {
  it("never calls a pass that reached no copy up to date", () => {
    const said = syncSay(report({ reached: 0, targets: [copy({ failed: "offline", retry_in: 300 })] }));
    expect(said).toBe("Could not reach Google Drive. Trying again in 5 min.");
  });

  it("says a pass that stopped part way did not finish", () => {
    expect(syncSay(report({ error: "network down" }))).toBe("Sync did not finish. network down");
  });

  it("says another sync runs when this one was skipped", () => {
    expect(syncSay(report({ skipped: true }))).toBe("A sync is already running.");
  });

  it("names a copy left out of a pass that reached another", () => {
    const said = syncSay(report({ ops_pushed: 2, reached: 1, targets: [copy(), copy({ id: "t2", label: "USB disk", waiting: true, retry_in: 20 })] }));
    expect(said).toBe("Synced. Could not reach USB disk. Trying again shortly.");
  });

  it("tells the user to update when another device is newer", () => {
    expect(syncSay(report({ needs_update: true }))).toContain("newer version");
  });

  it("counts what phone backup added", () => {
    expect(syncSay(report({ inbox_imported: 3 }))).toBe("Synced. 3 items from phone backup were added.");
  });

  it("is up to date only when a copy answered and nothing moved", () => {
    expect(syncSay(report())).toBe("Already up to date.");
  });
});

describe("describeProgress", () => {
  const step = { silo_id: "s", done: 3, total: 9, bytes_done: 0, bytes_total: 0, file_id: null, name: null };

  it("keeps one line for the steps that only count", () => {
    expect(describeProgress({ ...step, phase: "sending-changes" })).toBe("Syncing…");
    expect(describeProgress({ ...step, phase: "fetching-changes" })).toBe("Syncing…");
    expect(describeProgress(null)).toBe("Syncing…");
  });

  it("names the file and its bytes while one moves", () => {
    const line = describeProgress({ ...step, phase: "uploading", bytes_done: 1024, bytes_total: 2048, name: "a.mp4" });
    expect(line).toContain("Uploading");
    expect(line).toContain("a.mp4");
  });

  it("says how many items phone backup adds", () => {
    expect(describeProgress({ ...step, phase: "importing" })).toBe("Adding 9 items from phone backup");
  });
});
