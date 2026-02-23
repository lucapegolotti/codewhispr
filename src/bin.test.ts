import { describe, it, expect } from "vitest";
import { symlink, rm } from "fs/promises";
import { spawn } from "child_process";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, ".."); // src/.. = project root

describe("bin/codedove — symlink CWD regression", () => {
  it("starts without 'React is not defined' when invoked via a symlinked directory from a foreign CWD", async () => {
    // Replicate npm-link structure: a symlink-directory → project root.
    const symlinkDir = join(tmpdir(), `cw-bintest-${Date.now()}`);
    await symlink(PROJECT_ROOT, symlinkDir);

    let output = "";
    const scriptPath = join(symlinkDir, "bin", "codedove");
    const child = spawn(scriptPath, [], {
      cwd: tmpdir(),           // NOT the project root
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { output += d.toString(); });

    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    child.kill();
    await rm(symlinkDir, { force: true });

    expect(output).not.toContain("React is not defined");
    expect(output).not.toContain("ReferenceError");
  }, 10_000);
});
