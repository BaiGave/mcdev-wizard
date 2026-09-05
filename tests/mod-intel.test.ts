import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { buildModrinthSearchUrl, pickModrinthVersion } from "../src/mod-intel/modrinth.js";
import type { ModIntelVersion } from "../src/mod-intel/types.js";
import { githubArchiveUrl, parseGithubUrl, resolveGithubSource } from "../src/mod-intel/github.js";
import {
  getModIntelStatus,
  resolveExternalMod,
  startModIntelSourceTask,
  upsertCompatibilityProfile,
} from "../src/mod-intel/service.js";

const cleanup: string[] = [];
const originalFetch = globalThis.fetch;
const originalDmclHome = process.env.DMCL_HOME;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDmclHome === undefined) delete process.env.DMCL_HOME;
  else process.env.DMCL_HOME = originalDmclHome;
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("mod intelligence providers", () => {
  it("requires version, loader, and Minecraft filters to match the same release", () => {
    const versions: ModIntelVersion[] = [
      { id: "forge-new", versionNumber: "2.0", loaders: ["forge"], gameVersions: ["1.21.1"], datePublished: "2026-02-01", files: [], dependencies: [] },
      { id: "fabric-old", versionNumber: "2.0", loaders: ["fabric"], gameVersions: ["1.20.1"], datePublished: "2026-01-01", files: [], dependencies: [] },
    ];
    assert.equal(pickModrinthVersion(versions, { loader: "neoforge" }), undefined);
    assert.equal(pickModrinthVersion(versions, { loader: "fabric", mcVersion: "1.21.1" }), undefined);
    assert.equal(pickModrinthVersion(versions, { versionId: "forge-new", loader: "fabric" }), undefined);
    assert.equal(pickModrinthVersion(versions, { versionNumber: "2.0", loader: "fabric" })?.id, "fabric-old");
    assert.equal(pickModrinthVersion(versions, {})?.id, "forge-new");
  });

  it("builds Modrinth search facets for mod, loader, and Minecraft version", () => {
    const url = new URL(buildModrinthSearchUrl({
      query: "sodium",
      loader: "fabric",
      mcVersion: "1.21.1",
      category: "optimization",
      sort: "downloads",
      limit: 40,
    }));
    assert.equal(url.searchParams.get("query"), "sodium");
    assert.equal(url.searchParams.get("index"), "downloads");
    assert.equal(url.searchParams.get("limit"), "40");
    assert.deepEqual(JSON.parse(url.searchParams.get("facets") || "[]"), [
      ["project_type:mod"],
      ["categories:fabric"],
      ["versions:1.21.1"],
      ["categories:optimization"],
    ]);
  });

  it("parses GitHub refs and resolves Modrinth source candidates", async () => {
    const parsed = parseGithubUrl("https://github.com/CaffeineMC/sodium-fabric/tree/mc1.21.1");
    assert.deepEqual(parsed, {
      owner: "CaffeineMC",
      repo: "sodium-fabric",
      ref: "mc1.21.1",
    });
    assert.equal(
      githubArchiveUrl("CaffeineMC", "sodium-fabric", "mc1.21.1"),
      "https://api.github.com/repos/CaffeineMC/sodium-fabric/zipball/mc1.21.1",
    );

    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/project/sodium/version")) {
        return jsonResponse([{
          id: "ver1",
          project_id: "proj1",
          name: "Sodium 0.6.0",
          version_number: "0.6.0",
          game_versions: ["1.21.1"],
          loaders: ["fabric", "neoforge", "forge"],
          date_published: "2026-01-02T00:00:00Z",
          files: [
            { filename: "sodium-0.6.0.jar", url: "https://cdn.example/sodium.jar", primary: true, hashes: { sha1: "abc" } },
            { filename: "sodium-0.6.0-sources.jar", url: "https://cdn.example/sodium-sources.jar", hashes: { sha1: "def" } },
          ],
          dependencies: [{ project_id: "fabric-api", dependency_type: "optional" }],
        }]);
      }
      if (url.includes("/project/sodium")) {
        return jsonResponse({
          id: "sodium",
          slug: "sodium",
          title: "Sodium",
          source_url: "https://github.com/CaffeineMC/sodium-fabric",
          license: { id: "LGPL-3.0-only" },
        });
      }
      if (url.includes("/repos/CaffeineMC/sodium-fabric/tags")) {
        return jsonResponse([{ name: "0.6.0", commit: { sha: "abc123" } }]);
      }
      if (url.includes("/repos/CaffeineMC/sodium-fabric/commits/0.6.0")) {
        return jsonResponse({ sha: "abc123" });
      }
      if (url.includes("/repos/CaffeineMC/sodium-fabric")) {
        return jsonResponse({
          html_url: "https://github.com/CaffeineMC/sodium-fabric",
          default_branch: "dev",
          license: { spdx_id: "LGPL-3.0-only" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const target = await resolveExternalMod({
      kind: "modrinth",
      projectIdOrSlug: "sodium",
      loader: "fabric",
      mcVersion: "1.21.1",
    });
    assert.equal(target.modId, "sodium");
    assert.equal(target.modVersion, "0.6.0");
    assert.equal(target.primaryFile?.fileName, "sodium-0.6.0.jar");
    assert.equal(target.sourceCandidates.some((candidate) => candidate.sourceKind === "sources-jar"), true);
    const github = target.sourceCandidates.find((candidate) => candidate.sourceKind === "github-source");
    assert.equal(github?.confidence, "exact");
    assert.equal(github?.url, githubArchiveUrl("CaffeineMC", "sodium-fabric", "abc123"));
    assert.match(target.dependencySnippets[0], /maven\.modrinth:sodium:0\.6\.0/);
    const neoforge = await resolveExternalMod({ kind: "modrinth", projectIdOrSlug: "sodium", loader: "neoforge", mcVersion: "1.21.1" });
    assert.match(neoforge.dependencySnippets[0], /compileOnly\("maven\.modrinth:/);
    assert.doesNotMatch(neoforge.dependencySnippets[0], /modImplementation/);
    const forge = await resolveExternalMod({ kind: "modrinth", projectIdOrSlug: "sodium", loader: "forge", mcVersion: "1.21.1" });
    assert.match(forge.dependencySnippets[0], /compileOnly\(fg\.deobf\("maven\.modrinth:/);
  });

  it("matches Minecraft branch candidates before falling back to the default GitHub branch", async () => {
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/repos/CaffeineMC/sodium/tags")) return jsonResponse([]);
      if (url.includes("/repos/CaffeineMC/sodium/commits/1.21.1%2Fstable")) {
        return jsonResponse({ sha: "stable-sha" });
      }
      if (url.includes("/repos/CaffeineMC/sodium/commits/")) {
        return new Response("missing", { status: 404 });
      }
      if (url.includes("/repos/CaffeineMC/sodium")) {
        return jsonResponse({
          html_url: "https://github.com/CaffeineMC/sodium",
          default_branch: "dev",
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const github = await resolveGithubSource("https://github.com/CaffeineMC/sodium", {
      version: "mc1.21.1-0.8.12-neoforge",
      mcVersion: "1.21.1",
      loader: "neoforge",
    });
    assert.equal(github?.ref, "1.21.1/stable");
    assert.equal(github?.commitSha, "stable-sha");
    assert.equal(github?.confidence, "high");
  });
});

describe("mod intelligence source tasks", () => {
  it("tries the next source when a downloaded archive contains no Java", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-source-fallback-"));
    cleanup.push(root);
    process.env.DMCL_HOME = path.join(root, "data");
    const artifact = path.join(root, "helper.jar");
    const modZip = new AdmZip();
    modZip.addFile("fabric.mod.json", Buffer.from(JSON.stringify({ id: "helper", version: "1.0" })));
    modZip.writeZip(artifact);
    const emptyArchive = path.join(root, "empty.zip");
    const emptyZip = new AdmZip();
    emptyZip.addFile("README.md", Buffer.from("No Java sources"));
    emptyZip.writeZip(emptyArchive);
    const sources = path.join(root, "sources.jar");
    const sourceZip = new AdmZip();
    sourceZip.addFile("Helper.java", Buffer.from("public class Helper {}"));
    sourceZip.writeZip(sources);
    startModIntelSourceTask({
      loader: "fabric", mcVersion: "1.20.1",
      target: {
        provider: "local", title: "Helper", modId: "helper", modName: "Helper", modVersion: "1.0",
        localArtifactPath: artifact, dependencySnippets: [],
        sourceCandidates: [
          { provider: "github", sourceKind: "github-source", path: emptyArchive, confidence: "high", reason: "empty archive" },
          { provider: "manual", sourceKind: "manual-source", path: sources, confidence: "high", reason: "valid sources" },
        ],
      },
    });
    for (let attempt = 0; attempt < 100 && getModIntelStatus().task?.state === "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const task = getModIntelStatus().task;
    assert.equal(task?.state, "completed", task?.lastError);
    assert.equal(task?.result?.entry.sourceKind, "manual-source");
    assert.equal(fs.existsSync(emptyArchive), true);
    assert.equal(fs.existsSync(sources), true);
  });

  it("materializes an external source archive and saves a preview-only compatibility profile", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-mod-intel-"));
    cleanup.push(root);
    process.env.DMCL_HOME = path.join(root, "data");
    const modJar = path.join(root, "helper-1.0.0.jar");
    const sourceJar = path.join(root, "helper-1.0.0-sources.jar");
    const modZip = new AdmZip();
    modZip.addFile("fabric.mod.json", Buffer.from(JSON.stringify({
      id: "helper",
      name: "Helper",
      version: "1.0.0",
      license: "MIT",
    })));
    modZip.addFile("com/example/helper/Helper.class", Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
    modZip.writeZip(modJar);
    const sourceZip = new AdmZip();
    sourceZip.addFile("com/example/helper/Helper.java", Buffer.from("package com.example.helper; public class Helper {}"));
    sourceZip.writeZip(sourceJar);
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    globalThis.fetch = async () => new Response("bad gateway", { status: 502 });

    const target = {
      provider: "local" as const,
      title: "Helper",
      modId: "helper",
      modName: "Helper",
      modVersion: "1.0.0",
      localArtifactPath: modJar,
      sourceCandidates: [{
        sourceKind: "github-source" as const,
        provider: "github" as const,
        url: "https://example.invalid/helper.zip",
        confidence: "high" as const,
        reason: "unreachable test source",
      }, {
        sourceKind: "manual-source" as const,
        provider: "manual" as const,
        path: sourceJar,
        confidence: "high" as const,
        reason: "test source archive",
      }],
      dependencySnippets: ['compileOnly("com.example:helper:1.0.0")'],
    };

    const started = startModIntelSourceTask({
      target,
      loader: "fabric",
      mcVersion: "1.20.1",
      projectPath: project,
      preferredSourceKind: "github-source",
    });
    assert.equal(started.state, "running");
    for (let attempt = 0; attempt < 100 && getModIntelStatus().task?.state === "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const task = getModIntelStatus().task;
    assert.equal(task?.state, "completed");
    assert.equal(task?.result?.entry.sourceKind, "manual-source");
    assert.equal(task?.result?.entry.layout?.readableSourcePath, "source-code");
    assert.equal(task?.logs.some((line) => line.includes("Source candidate failed")), true);
    assert.equal(fs.existsSync(path.join(task!.result!.sourcePath, "com", "example", "helper", "Helper.java")), true);
    assert.equal(fs.existsSync(path.join(task!.result!.path, "src", "com", "example", "helper", "Helper.java")), true);
    assert.equal(fs.existsSync(path.join(task!.result!.path, "artifacts", "mod-original.jar")), true);
    assert.equal(fs.existsSync(path.join(task!.result!.path, "artifacts", "mod-sources.jar")), false);
    assert.equal(fs.existsSync(path.join(task!.result!.path, "artifacts", "github-source.zip")), false);
    assert.equal(fs.existsSync(task!.result!.reportPath!), true);
    assert.equal(task!.result!.projectSourcePath, path.join(project, ".dmcl", "sources"));
    assert.equal(fs.existsSync(path.join(task!.result!.projectModSourcePath!, "com", "example", "helper", "Helper.java")), true);

    const profile = await upsertCompatibilityProfile(project, "variant-1", {
      target: { ...target, loader: "fabric", minecraftVersion: "1.20.1" },
      sourceUnitId: task!.result!.unitId,
      dependencySnippets: target.dependencySnippets,
    });
    assert.equal(profile.dependencyMode, "preview-only");
    assert.equal(profile.sourceUnitId, task!.result!.unitId);
    assert.deepEqual(profile.dependencySnippets, target.dependencySnippets);
    assert.equal(fs.existsSync(path.join(project, ".dmcl", "compat", "helper", "fabric-1.20.1.json")), true);
  });
});
