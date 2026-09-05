import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { materializeExternalModSource, projectExternalModSource } from "../src/sources/service.js";
import type { ModSourceEntry } from "../src/sources/types.js";

let root: string;
const originalDmclHome = process.env.DMCL_HOME;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-source-integrity-"));
  process.env.DMCL_HOME = path.join(root, "data");
});

afterEach(() => {
  if (originalDmclHome === undefined) delete process.env.DMCL_HOME;
  else process.env.DMCL_HOME = originalDmclHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function sourceEntry(modId: string): ModSourceEntry {
  const unit = path.join(root, "units", modId);
  const src = path.join(unit, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "Helper.java"), "public class Helper {}");
  return {
    loader: "fabric", minecraftVersion: "1.20.1", modId, modName: modId, modVersion: "1.0",
    artifactSha256: "a".repeat(64), sourceKind: "sources-jar", javaFiles: 1,
    path: unit, sourcePath: src,
  };
}

describe("source projection integrity", () => {
  it("retains both mod entries when independent source tasks finish together", async () => {
    const project = path.join(root, "project");
    const first = sourceEntry("first");
    const second = sourceEntry("second");
    await Promise.all([
      projectExternalModSource(project, first),
      projectExternalModSource(project, second),
    ]);
    const index = JSON.parse(fs.readFileSync(path.join(project, ".dmcl", "sources", "index.json"), "utf8"));
    assert.deepEqual(index.mods.map((mod: ModSourceEntry) => mod.modId).sort(), ["first", "second"]);
  });

  it("excludes generated sources in a Git worktree using the shared Git directory", async () => {
    const repo = path.join(root, "repo");
    const project = path.join(root, "worktree");
    fs.mkdirSync(repo);
    const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    git(["init"]);
    git(["-c", "user.name=DMCL Test", "-c", "user.email=dmcl-test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
    git(["worktree", "add", "--detach", project, "HEAD"]);
    await projectExternalModSource(project, sourceEntry("helper"));
    assert.equal(git(["check-ignore", ".dmcl/sources/index.json"], project).trim(), ".dmcl/sources/index.json");
  });

  it("restores the previous source unit when a Windows copy fallback fails", async (t) => {
    const artifact = path.join(root, "helper.jar");
    const sources = path.join(root, "helper-sources.jar");
    const jar = new AdmZip();
    jar.addFile("fabric.mod.json", Buffer.from(JSON.stringify({ id: "helper", version: "1.0" })));
    jar.writeZip(artifact);
    const zip = new AdmZip();
    zip.addFile("Helper.java", Buffer.from("public class Helper {}"));
    zip.writeZip(sources);
    const options = {
      loader: "fabric" as const, minecraftVersion: "1.20.1", modId: "helper", modName: "Helper", modVersion: "1.0",
      artifactFile: artifact, sourceArchiveFile: sources,
    };
    const entry = await materializeExternalModSource(options);
    const originalRename = fs.promises.rename;
    const originalCopy = fs.promises.cp;
    t.mock.method(fs.promises, "rename", async (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).includes(".partial-") && String(to) === entry.path) {
        throw Object.assign(new Error("directory locked"), { code: "EPERM" });
      }
      return originalRename(from, to);
    });
    t.mock.method(fs.promises, "cp", async (...args: Parameters<typeof originalCopy>) => {
      if (String(args[1]) === entry.path) {
        fs.mkdirSync(entry.path, { recursive: true });
        fs.writeFileSync(path.join(entry.path, "partial-copy"), "incomplete");
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return originalCopy(...args);
    });
    try {
      await assert.rejects(materializeExternalModSource({ ...options, force: true }), /disk full/);
    } finally {
      t.mock.restoreAll();
    }
    assert.equal(fs.readFileSync(path.join(entry.sourcePath, "Helper.java"), "utf8"), "public class Helper {}");
    assert.equal(fs.existsSync(path.join(entry.path, "READY")), true);
    assert.equal(fs.existsSync(path.join(entry.path, "partial-copy")), false);
  });
});
