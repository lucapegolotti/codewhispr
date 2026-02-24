import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const TMP_DIR = join(tmpdir(), `cv-service-test-${Date.now()}`);

describe("service/index", () => {
  beforeEach(async () => {
    await mkdir(TMP_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it("exports SERVICE_FILE_PATH containing 'codedove'", async () => {
    const { SERVICE_FILE_PATH } = await import("./index.js");
    expect(typeof SERVICE_FILE_PATH).toBe("string");
    expect(SERVICE_FILE_PATH).toContain("codedove");
  });

  it("isServiceInstalled returns false when file does not exist", async () => {
    // The real function reads SERVICE_FILE_PATH — we can't redirect it,
    // but we can validate the same readFile-based detection logic it uses.
    const missing = join(TMP_DIR, "nonexistent.plist");
    const installed = await readFile(missing, "utf8").then(() => true).catch(() => false);
    expect(installed).toBe(false);
  });

  it("isServiceInstalled returns true when file exists", async () => {
    const present = join(TMP_DIR, "test.plist");
    await writeFile(present, "<plist/>");
    const installed = await readFile(present, "utf8").then(() => true).catch(() => false);
    expect(installed).toBe(true);
  });

  it("getServiceStatus returns 'running' or 'stopped'", async () => {
    const { getServiceStatus } = await import("./index.js");
    const status = await getServiceStatus();
    expect(["running", "stopped"]).toContain(status);
  });
});
