import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { resolveDmclHome } from "../src/core/dmcl-home.js";
import { MappingsCache, resolveMappings } from "../src/meta/mappings-cache.js";
import { usesLegacyForgeMcp } from "../src/meta/mc-version.js";
import {
  getMinecraftSourceUnitDir,
  getSourceGradleHome,
  listMinecraftSourceEntries,
  sourceUnitReady,
} from "../src/sources/paths.js";
import {
  detectProjectMapping,
  getMinecraftSourceStatus,
  getProjectSourceStatus,
  listProjectRuntimeMods,
  materializeMinecraftSourcesFromProject,
  projectExternalModSource,
  sha256File,
  startMinecraftSourceTask,
} from "../src/sources/service.js";

const cleanup: string[] = [];
const originalDmclHome = process.env.DMCL_HOME;

afterEach(() => {
  if (originalDmclHome === undefined) delete process.env.DMCL_HOME;
  else process.env.DMCL_HOME = originalDmclHome;
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("DMCL data root", () => {
  it("uses an explicit home and supports portable EXE layout", () => {
    assert.equal(
      resolveDmclHome({ env: { DMCL_HOME: "D:\\DMCL-Data" }, execPath: "C:\\Apps\\DMCL.exe" }),
      path.resolve("D:\\DMCL-Data"),
    );
    assert.equal(
      resolveDmclHome({
        env: {},
        platform: "win32",
        execPath: "C:\\Portable\\DMCL.exe",
        fileExists: (file) => file.endsWith("portable.flag"),
      }),
      path.join("C:\\Portable", "data"),
    );
  });
});

describe("legacy Forge mappings", () => {
  it("selects MCP before Forge 1.16.5", async () => {
    assert.equal(usesLegacyForgeMcp("1.16.4"), true);
    assert.equal(usesLegacyForgeMcp("1.16.5"), false);
    const entry = await resolveMappings("forge", "1.12.2");
    assert.equal(entry.default, "mcp");
    assert.deepEqual(entry.options.map((option) => option.id), ["mcp"]);
    const cache = new MappingsCache();
    assert.equal(cache.isIncomplete({
      loader: "forge",
      mcVersion: "1.12.2",
      options: [{ id: "mojmap", label: "官方默认", available: true }],
      default: "mojmap",
      updatedAt: new Date().toISOString(),
    }), true);
  });

  it("reads snapshot and official mappings from generated MDKs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-forge-mapping-"));
    cleanup.push(dir);
    const fallback = { loader: "forge" as const, mcVersion: "1.12.2", mapping: "mcp" as const, mappingVersion: "1.12.2" };
    fs.writeFileSync(path.join(dir, "build.gradle"), "minecraft { mappings channel: 'snapshot', version: '20171003-1.12' }");
    assert.deepEqual(detectProjectMapping(dir, fallback), {
      mapping: "mcp",
      mappingVersion: "snapshot_20171003-1.12",
    });
    fs.writeFileSync(path.join(dir, "build.gradle"), "minecraft { mappings channel: 'official', version: '1.16.5' }");
    assert.deepEqual(detectProjectMapping(dir, { ...fallback, mcVersion: "1.16.5", mapping: "mojmap" }), {
      mapping: "mojmap",
      mappingVersion: "official_1.16.5",
    });
  });
});

describe("Minecraft source vault", () => {
  it("rejects an empty stale cache and repairs it from the retained source archive", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-sources-repair-"));
    cleanup.push(root);
    process.env.DMCL_HOME = path.join(root, "data");
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });

    const unit = getMinecraftSourceUnitDir("fabric", "1.21.1", "mojmap");
    const archive = path.join(unit, "artifacts", "minecraft-merged-sources.jar");
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.mkdirSync(path.join(unit, "src"), { recursive: true });
    const zip = new AdmZip();
    for (let index = 0; index < 101; index++) {
      zip.addFile(`net/minecraft/test/Class${index}.java`, Buffer.from(`package net.minecraft.test; public class Class${index} {}`));
    }
    zip.writeZip(archive);
    const artifactHash = await sha256File(archive);
    const generatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(unit, "manifest.json"), JSON.stringify({
      schema: 1,
      minecraftVersion: "1.21.1",
      loader: "fabric",
      mapping: "mojmap",
      mappingVersion: "1.21.1",
      sourceKind: "loader-sources",
      javaFiles: 101,
      generatedAt,
      relativeSourcePath: "src",
      artifacts: [{
        role: "minecraft-merged-sources",
        path: "artifacts/minecraft-merged-sources.jar",
        sha256: artifactHash,
        size: fs.statSync(archive).size,
      }],
    }), "utf8");
    fs.writeFileSync(path.join(unit, "READY"), generatedAt, "utf8");

    assert.equal(sourceUnitReady(unit), false);
    const logs: string[] = [];
    const entry = await materializeMinecraftSourcesFromProject({
      projectPath: project,
      loader: "fabric",
      mcVersion: "1.21.1",
      mapping: "mojmap",
      mappingVersion: "1.21.1",
      log: (line) => logs.push(line),
    });
    assert.equal(sourceUnitReady(unit), true);
    assert.equal(entry.javaFiles, 101);
    assert.equal(fs.existsSync(path.join(unit, "src", "net", "minecraft", "test", "Class100.java")), true);
    assert.equal(logs.some((line) => line.includes("恢复 101 个 Java 文件")), true);
  });

  it("materializes loader sources into the stable relative hierarchy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-sources-"));
    cleanup.push(root);
    process.env.DMCL_HOME = path.join(root, "data");
    const project = path.join(root, "project");
    const archive = path.join(
      project,
      ".gradle", "loom-cache", "minecraftMaven", "net", "minecraft", "test",
      "minecraft-common-1.20.1-sources.jar",
    );
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(path.join(project, "gradle.properties"), "loader_version=0.16.10\n");
    const zip = new AdmZip();
    for (let index = 0; index < 101; index++) {
      zip.addFile(`net/minecraft/test/Class${index}.java`, Buffer.from(`package net.minecraft.test; public class Class${index} {}`));
    }
    zip.writeZip(archive);

    const entry = await materializeMinecraftSourcesFromProject({
      projectPath: project,
      loader: "fabric",
      mcVersion: "1.20.1",
      mapping: "yarn",
      mappingVersion: "1.20.1+build.10",
    });
    const expectedUnit = path.join(
      process.env.DMCL_HOME,
      "sources", "v1", "minecraft", "fabric", "1.20.1", "yarn",
    );
    assert.equal(getMinecraftSourceUnitDir("fabric", "1.20.1", "yarn"), expectedUnit);
    assert.equal(entry.sourcePath, path.join(expectedUnit, "src"));
    assert.equal(entry.javaFiles, 101);
    assert.equal(sourceUnitReady(expectedUnit), true);
    assert.equal(fs.existsSync(path.join(entry.sourcePath, "net", "minecraft", "test", "Class100.java")), true);
    assert.equal(listMinecraftSourceEntries().length, 1);
  });

  it("projects cached MC and dependency sources into .dmcl without Git tracking", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-project-sources-"));
    cleanup.push(root);
    process.env.DMCL_HOME = path.join(root, "data");
    const project = path.join(root, "project");
    fs.mkdirSync(path.join(project, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(project, ".git", "info", "exclude"), "", "utf8");
    fs.writeFileSync(path.join(project, "gradle.properties"), "minecraft_version=1.20.1\nyarn_mappings=1.20.1+build.10\n", "utf8");

    const modJar = path.join(root, "helper-1.0.0.jar");
    const modZip = new AdmZip();
    modZip.addFile("fabric.mod.json", Buffer.from(JSON.stringify({ id: "helper", name: "Helper", version: "1.0.0", license: "MIT" })));
    modZip.addFile("com/example/helper/Helper.class", Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
    modZip.writeZip(modJar);
    const platformJar = path.join(root, "fabric-api-base.jar");
    const platformZip = new AdmZip();
    platformZip.addFile("fabric.mod.json", Buffer.from(JSON.stringify({ id: "fabric-api-base", name: "Fabric API Base", version: "1.0.0" })));
    platformZip.addFile("net/fabricmc/fabric/api/base/Base.class", Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
    platformZip.writeZip(platformJar);
    const escapedBatchJar = modJar.replace(/\|/g, "^|");
    const escapedPlatformJar = platformJar.replace(/\|/g, "^|");
    fs.writeFileSync(
      path.join(project, "gradlew.bat"),
      `@echo off\r\necho DMCL_DEP^|com.example^|helper^|1.0.0^|${escapedBatchJar}\r\necho DMCL_DEP^|net.fabricmc.fabric-api^|fabric-api-base^|1.0.0^|${escapedPlatformJar}\r\n`,
      "utf8",
    );
    const shellWrapper = path.join(project, "gradlew");
    fs.writeFileSync(shellWrapper, `#!/bin/sh\nprintf '%s\\n' 'DMCL_DEP|com.example|helper|1.0.0|${modJar}' 'DMCL_DEP|net.fabricmc.fabric-api|fabric-api-base|1.0.0|${platformJar}'\n`, "utf8");
    fs.chmodSync(shellWrapper, 0o755);

    const mcUnit = getMinecraftSourceUnitDir("fabric", "1.20.1", "yarn");
    fs.mkdirSync(path.join(mcUnit, "src", "net", "minecraft"), { recursive: true });
    fs.writeFileSync(path.join(mcUnit, "src", "net", "minecraft", "Minecraft.java"), "package net.minecraft; class Minecraft {}", "utf8");
    const generatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(mcUnit, "manifest.json"), JSON.stringify({
      schema: 1,
      minecraftVersion: "1.20.1",
      loader: "fabric",
      mapping: "yarn",
      mappingVersion: "1.20.1+build.10",
      sourceKind: "loader-sources",
      javaFiles: 1,
      generatedAt,
      relativeSourcePath: "src",
      artifacts: [],
    }), "utf8");
    fs.writeFileSync(path.join(mcUnit, "READY"), generatedAt, "utf8");

    const dependencySources = path.join(
      getSourceGradleHome(),
      "caches", "modules-2", "files-2.1",
      "com.example", "helper", "1.0.0", "source-hash", "helper-1.0.0-sources.jar",
    );
    fs.mkdirSync(path.dirname(dependencySources), { recursive: true });
    const sourceZip = new AdmZip();
    sourceZip.addFile("com/example/helper/Helper.java", Buffer.from("package com.example.helper; public class Helper {}"));
    sourceZip.writeZip(dependencySources);

    startMinecraftSourceTask({
      scope: "single",
      loader: "fabric",
      mcVersion: "1.20.1",
      mapping: "yarn",
      projectPath: project,
      includeDependencies: true,
    });
    for (let attempt = 0; attempt < 200 && getMinecraftSourceStatus().task?.state === "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const task = getMinecraftSourceStatus().task;
    assert.equal(task?.state, "completed");
    assert.equal(task?.dependenciesPrepared, 1);
    assert.equal(task?.outputPath, path.join(project, ".dmcl", "sources"));
    assert.equal(fs.existsSync(path.join(project, ".dmcl", "sources", "minecraft", "src", "net", "minecraft", "Minecraft.java")), true);
    assert.equal(fs.existsSync(path.join(project, ".dmcl", "sources", "mods", "helper", "1.0.0", "src", "com", "example", "helper", "Helper.java")), true);
    assert.equal(fs.existsSync(path.join(project, ".dmcl", "sources", "mods", "helper", "1.0.0", "index", "api-report.md")), true);
    assert.equal(fs.existsSync(path.join(project, ".dmcl", "sources", "mods", "helper", "1.0.0", "index", "metadata.json")), true);
    const projectIndex = JSON.parse(fs.readFileSync(path.join(project, ".dmcl", "sources", "index.json"), "utf8"));
    assert.equal(projectIndex.mods.some((entry: { modId?: string }) => entry.modId === "fabric-api-base"), false);
    const helper = projectIndex.mods.find((entry: { modId?: string }) => entry.modId === "helper");
    assert.equal(helper.sourceKind, "sources-jar");
    assert.equal(helper.origin.provider, "gradle");
    assert.deepEqual(helper.artifact.maven, { group: "com.example", name: "helper", version: "1.0.0" });
    assert.equal(helper.confidence, "high");
    assert.equal(helper.license.id, "MIT");
    assert.equal(helper.reportPath, "index/api-report.md");
    assert.equal(helper.layout.readableSourcePath, "source-code");
    assert.equal(fs.existsSync(path.join(helper.path, "source-code", "com", "example", "helper", "Helper.java")), true);
    assert.equal(fs.existsSync(path.join(helper.path, "artifacts", "mod-sources.jar")), false);
    const sourceStatus = getProjectSourceStatus(project);
    assert.equal(sourceStatus.modCount, 1);
    assert.equal(sourceStatus.mods?.[0]?.modId, "helper");
    assert.equal(sourceStatus.mods?.[0]?.confidence, "high");
    assert.equal(
      sourceStatus.mods?.[0]?.reportFilePath,
      path.join(project, ".dmcl", "sources", "mods", "helper", "1.0.0", "index", "api-report.md"),
    );
    const report = fs.readFileSync(path.join(project, ".dmcl", "sources", "mods", "helper", "1.0.0", "index", "api-report.md"), "utf8");
    assert.match(report, /Helper \(helper\)/);
    assert.match(report, /com\.example\.helper\.Helper/);
    assert.match(fs.readFileSync(path.join(project, ".git", "info", "exclude"), "utf8"), /\/\.dmcl\//);
  });

  it("projects cached Minecraft sources immediately without resolving Gradle dependencies", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-project-minecraft-only-"));
    cleanup.push(root);
    process.env.DMCL_HOME = path.join(root, "data");
    const project = path.join(root, "project");
    const marker = path.join(root, "gradle-was-invoked");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "gradle.properties"), "minecraft_version=26.2\n", "utf8");
    fs.writeFileSync(path.join(project, "gradlew.bat"), `@echo off\r\ntype nul > "${marker}"\r\n`, "utf8");
    fs.writeFileSync(path.join(project, "gradlew"), `#!/bin/sh\ntouch '${marker}'\n`, "utf8");
    fs.chmodSync(path.join(project, "gradlew"), 0o755);

    const mcUnit = getMinecraftSourceUnitDir("fabric", "26.2", "mojmap");
    fs.mkdirSync(path.join(mcUnit, "src", "net", "minecraft"), { recursive: true });
    fs.writeFileSync(path.join(mcUnit, "src", "net", "minecraft", "Minecraft.java"), "package net.minecraft; class Minecraft {}", "utf8");
    const generatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(mcUnit, "manifest.json"), JSON.stringify({
      schema: 1,
      minecraftVersion: "26.2",
      loader: "fabric",
      mapping: "mojmap",
      mappingVersion: "26.2",
      sourceKind: "loader-sources",
      javaFiles: 1,
      generatedAt,
      relativeSourcePath: "src",
      artifacts: [],
    }), "utf8");
    fs.writeFileSync(path.join(mcUnit, "READY"), generatedAt, "utf8");

    startMinecraftSourceTask({
      scope: "single",
      loader: "fabric",
      mcVersion: "26.2",
      mapping: "mojmap",
      projectPath: project,
      includeDependencies: false,
    });
    for (let attempt = 0; attempt < 100 && getMinecraftSourceStatus().task?.state === "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const task = getMinecraftSourceStatus().task;
    assert.equal(task?.state, "completed");
    assert.equal(task?.dependenciesFound, 0);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(path.join(project, ".dmcl", "sources", "minecraft", "src", "net", "minecraft", "Minecraft.java")), true);
  });

  it("projects an adaptation-center source into the selected project without replacing Minecraft sources", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-project-external-source-"));
    cleanup.push(root);
    process.env.DMCL_HOME = path.join(root, "data");
    const project = path.join(root, "project");
    const cached = path.join(root, "cached", "sodium");
    fs.mkdirSync(path.join(cached, "src", "me", "jellysquid", "mods", "sodium"), { recursive: true });
    fs.mkdirSync(path.join(cached, "index"), { recursive: true });
    fs.writeFileSync(path.join(cached, "src", "me", "jellysquid", "mods", "sodium", "Sodium.java"), "class Sodium {}", "utf8");
    fs.writeFileSync(path.join(cached, "index", "api-report.md"), "# Sodium", "utf8");
    const entry = {
      loader: "neoforge" as const,
      minecraftVersion: "1.21.1",
      modId: "sodium",
      modName: "Sodium",
      modVersion: "0.8.12+mc1.21.1",
      artifactSha256: "a".repeat(64),
      sourceKind: "github-source" as const,
      confidence: "high" as const,
      javaFiles: 1,
      path: cached,
      sourcePath: path.join(cached, "src"),
      layout: { stableSourcePath: "src" as const, readableSourcePath: "source-code" as const, sourceArchiveRetained: false },
      reportPath: "index/api-report.md",
    };

    const projection = await projectExternalModSource(project, entry);
    assert.equal(projection.rootPath, path.join(project, ".dmcl", "sources"));
    assert.equal(fs.existsSync(path.join(projection.modSourcePath, "me", "jellysquid", "mods", "sodium", "Sodium.java")), true);
    assert.equal(fs.existsSync(path.join(project, ".dmcl", "sources", "mods", "sodium", "0.8.12+mc1.21.1", "src", "me", "jellysquid", "mods", "sodium", "Sodium.java")), true);
    assert.match(fs.readFileSync(path.join(project, ".dmcl", "sources", "mods", "sodium", "0.8.12+mc1.21.1", "SOURCE.md"), "utf8"), /github-source/);
    const status = getProjectSourceStatus(project);
    assert.equal(status.ready, true);
    assert.equal(status.minecraftReady, false);
    assert.equal(status.modCount, 1);
  });

  it("lists recognizable runtime mod jars from run/mods for selective source preparation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-runtime-mods-"));
    cleanup.push(root);
    process.env.DMCL_HOME = path.join(root, "data");
    const project = path.join(root, "project");
    const runtimeRoot = path.join(project, "run", "mods");
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const modJar = path.join(runtimeRoot, "helper-1.0.0.jar");
    const modZip = new AdmZip();
    modZip.addFile("fabric.mod.json", Buffer.from(JSON.stringify({ id: "helper", name: "Helper", version: "1.0.0" })));
    modZip.addFile("com/example/helper/Helper.class", Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
    modZip.writeZip(modJar);
    fs.writeFileSync(path.join(runtimeRoot, "not-a-mod.jar"), "plain text", "utf8");
    fs.writeFileSync(path.join(runtimeRoot, "ignored.jar.bak"), "not scanned", "utf8");

    const mods = await listProjectRuntimeMods(project, "fabric", "1.20.1");
    assert.equal(mods.length, 2);
    const helper = mods.find((item) => item.modId === "helper");
    assert.equal(helper?.supported, true);
    assert.equal(helper?.relativePath, path.join("run", "mods", "helper-1.0.0.jar"));
    assert.equal(helper?.source?.ready, false);
    assert.equal(mods.some((item) => item.relativePath.endsWith("ignored.jar.bak")), false);
  });
});
