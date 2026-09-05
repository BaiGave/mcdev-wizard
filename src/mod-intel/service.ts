import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { downloadFile } from "../core/http.js";
import type { LoaderId } from "../types.js";
import { compareMcVersions } from "../meta/mc-version.js";
import {
  detectModLicense,
  detectModMetadata,
  materializeExternalModSource,
  projectExternalModSource,
  sha256File,
} from "../sources/service.js";
import { getSourceVaultRoot, safeSourceSegment } from "../sources/paths.js";
import type { ModSourceEntry, SourceConfidence } from "../sources/types.js";
import { resolveGithubSource } from "./github.js";
import {
  getModrinthProject,
  getModrinthVersions,
  modrinthLicense,
  pickModrinthVersion,
  pickPrimaryModrinthFile,
  pickSourceModrinthFile,
  searchModrinth,
} from "./modrinth.js";
import {
  compatibilityProfilePath,
  getCompatibilityRoot,
  getModIntelDownloadRoot,
  resolveSourceUnitId,
} from "./paths.js";
import type {
  CompatibilityProfile,
  ModIntelFile,
  ModIntelResolveRequest,
  ModIntelResolvedTarget,
  ModIntelSearchRequest,
  ModIntelSearchResponse,
  ModIntelSourceCandidate,
  ModIntelSourcePrepareRequest,
  ModIntelStatus,
  ModIntelTaskSnapshot,
} from "./types.js";

const MAX_TASK_LOGS = 180;

function isLoader(value: unknown): value is LoaderId {
  return value === "fabric" || value === "forge" || value === "neoforge";
}

function dependencySnippets(target: {
  provider: string;
  slug?: string;
  projectId?: string;
  modVersion: string;
  loader?: LoaderId;
  mcVersion?: string;
}): string[] {
  if (target.provider !== "modrinth") return [];
  const artifact = target.slug || target.projectId;
  if (!artifact) return [];
  const coordinate = JSON.stringify(`maven.modrinth:${artifact}:${target.modVersion}`);
  let dependency = `compileOnly(${coordinate})`;
  if (target.loader === "fabric") dependency = `modImplementation(${coordinate})`;
  else if (target.loader === "forge") {
    dependency = target.mcVersion && compareMcVersions(target.mcVersion, "1.13") < 0
      ? `deobfCompile(${coordinate})`
      : `compileOnly(fg.deobf(${coordinate}))`;
  }
  return [
    [
      "repositories {",
      "    maven { url = uri(\"https://api.modrinth.com/maven\") }",
      "}",
      "",
      "dependencies {",
      `    ${dependency}`,
      "}",
    ].join("\n"),
  ];
}

function sourceCandidateFromGithub(
  candidate: Awaited<ReturnType<typeof resolveGithubSource>>,
): ModIntelSourceCandidate | null {
  if (!candidate) return null;
  return {
    sourceKind: "github-source",
    provider: "github",
    url: candidate.archiveUrl,
    confidence: candidate.confidence,
    reason: candidate.reason,
    repository: candidate,
  };
}

export async function searchExternalMods(request: ModIntelSearchRequest): Promise<ModIntelSearchResponse> {
  const source = request.source ?? "all";
  if (source === "curseforge") {
    return {
      provider: "modrinth",
      totalHits: 0,
      offset: request.offset ?? 0,
      limit: request.limit ?? 20,
      results: [],
      warnings: ["CurseForge requires an API key and is reserved for a later provider implementation."],
    };
  }
  const response = await searchModrinth(request);
  if (source === "all") {
    response.warnings.push("CurseForge is not queried in this build because no API key provider is configured.");
  }
  return response;
}

function normalizeModrinthSourceUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.trim() || undefined;
}

async function resolveModrinthTarget(request: Extract<ModIntelResolveRequest, { kind: "modrinth" }>): Promise<ModIntelResolvedTarget> {
  const project = await getModrinthProject(request.projectIdOrSlug);
  const versions = await getModrinthVersions(project.id);
  const selected = pickModrinthVersion(versions, {
    versionId: request.versionId,
    versionNumber: request.versionNumber,
    loader: request.loader,
    mcVersion: request.mcVersion,
  });
  if (!selected) throw new Error("No Modrinth version matched the selected filters.");
  const primaryFile = pickPrimaryModrinthFile(selected);
  if (!primaryFile) throw new Error("The selected Modrinth version has no downloadable jar.");

  const candidates: ModIntelSourceCandidate[] = [];
  const sourceFile = pickSourceModrinthFile(selected);
  if (sourceFile) {
    candidates.push({
      sourceKind: "sources-jar",
      provider: "modrinth",
      url: sourceFile.url,
      confidence: "high",
      reason: `version file ${sourceFile.fileName}`,
    });
  }
  const sourceUrl = normalizeModrinthSourceUrl(project.source_url);
  const loaders = selected.loaders.filter(isLoader);
  const selectedLoader = request.loader ?? loaders[0];
  const selectedMinecraftVersion = request.mcVersion ?? selected.gameVersions[0];
  const github = sourceUrl
    ? await resolveGithubSource(sourceUrl, {
      version: selected.versionNumber,
      mcVersion: selectedMinecraftVersion,
      loader: selectedLoader,
    }).catch(() => null)
    : null;
  const githubCandidate = sourceCandidateFromGithub(github);
  if (githubCandidate) candidates.push(githubCandidate);
  candidates.push({
    sourceKind: "cfr-decompile",
    provider: "modrinth",
    confidence: "medium",
    reason: "fallback to CFR when no matching source archive is available",
  });

  return {
    provider: "modrinth",
    projectId: project.id,
    slug: project.slug,
    title: project.title,
    modId: project.slug || project.id,
    modName: project.title,
    modVersion: selected.versionNumber,
    loader: selectedLoader,
    minecraftVersion: selectedMinecraftVersion,
    license: modrinthLicense(project),
    projectUrl: `https://modrinth.com/mod/${project.slug ?? project.id}`,
    sourceUrl,
    selectedVersion: selected,
    primaryFile,
    sourceCandidates: candidates,
    dependencySnippets: dependencySnippets({
      provider: "modrinth",
      slug: project.slug,
      projectId: project.id,
      modVersion: selected.versionNumber,
      loader: selectedLoader,
      mcVersion: selectedMinecraftVersion,
    }),
  };
}

async function resolveGithubTarget(request: Extract<ModIntelResolveRequest, { kind: "github" }>): Promise<ModIntelResolvedTarget> {
  const github = await resolveGithubSource(request.url, { version: request.version });
  if (!github) throw new Error("Not a supported GitHub repository URL.");
  return {
    provider: "github",
    title: `${github.owner}/${github.repo}`,
    modId: github.repo.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || github.repo,
    modName: github.repo,
    modVersion: request.version ?? github.ref,
    license: github.license,
    projectUrl: github.repositoryUrl,
    sourceUrl: github.repositoryUrl,
    sourceCandidates: [sourceCandidateFromGithub(github)!],
    dependencySnippets: [],
  };
}

async function resolveLocalTarget(request: Extract<ModIntelResolveRequest, { kind: "jar" | "local" | "gradle-dependency" }>): Promise<ModIntelResolvedTarget> {
  const file = request.kind === "gradle-dependency" ? request.file : request.path;
  if (!file) throw new Error("Missing local jar path.");
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`Jar does not exist: ${resolved}`);
  const fallbackName = request.kind === "gradle-dependency"
    ? (request.name ?? path.basename(resolved, path.extname(resolved)))
    : path.basename(resolved, path.extname(resolved));
  const metadata = detectModMetadata(resolved, fallbackName, request.version ?? "local")
    ?? { modId: fallbackName, modName: fallbackName, modVersion: request.version ?? "local" };
  const license = detectModLicense(resolved);
  return {
    provider: request.kind === "gradle-dependency" ? "gradle" : "local",
    title: metadata.modName,
    modId: metadata.modId,
    modName: metadata.modName,
    modVersion: metadata.modVersion,
    loader: request.loader,
    minecraftVersion: request.mcVersion,
    license: license.id || license.name,
    sourceCandidates: [{
      sourceKind: "cfr-decompile",
      provider: request.kind === "gradle-dependency" ? "gradle" : "local",
      confidence: "medium",
      reason: "local jar can be decompiled with CFR",
    }],
    primaryFile: {
      fileName: path.basename(resolved),
      url: `file://${resolved}`,
      hashes: { sha256: await sha256File(resolved) },
      size: fs.statSync(resolved).size,
    },
    dependencySnippets: request.kind === "gradle-dependency" && request.group && request.name && request.version
      ? [`compileOnly("${request.group}:${request.name}:${request.version}")`]
      : [],
    localArtifactPath: resolved,
  } as ModIntelResolvedTarget & { localArtifactPath: string };
}

export async function resolveExternalMod(request: ModIntelResolveRequest): Promise<ModIntelResolvedTarget> {
  if (request.kind === "modrinth") return resolveModrinthTarget(request);
  if (request.kind === "github") return resolveGithubTarget(request);
  return resolveLocalTarget(request);
}

async function hashFile(file: string, algorithm: "sha1" | "sha256" | "sha512"): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function verifyFileHashes(file: string, hashes?: Record<string, string>): Promise<void> {
  if (!hashes) return;
  for (const algorithm of ["sha512", "sha256", "sha1"] as const) {
    const expected = hashes[algorithm];
    if (!expected) continue;
    const actual = await hashFile(file, algorithm);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`${path.basename(file)} failed ${algorithm} verification`);
    }
    return;
  }
}

function safeDownloadName(fileName: string): string {
  return safeSourceSegment(fileName || `download-${randomUUID()}`);
}

interface DownloadCandidateSpec {
  url: string;
  fileName: string;
  hashes?: Record<string, string>;
  label?: string;
}

function encodeMavenSegment(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, "/");
}

function modrinthMavenUrl(project: string, version: string, fileName: string): string {
  return [
    "https://api.modrinth.com/maven/maven/modrinth",
    encodeMavenSegment(project),
    encodeMavenSegment(version),
    encodeMavenSegment(fileName),
  ].join("/");
}

function artifactDownloadCandidates(target: ModIntelResolvedTarget, file: ModIntelFile): DownloadCandidateSpec[] {
  const candidates: DownloadCandidateSpec[] = [{
    url: file.url,
    fileName: file.fileName,
    hashes: file.hashes,
    label: "primary file",
  }];
  if (target.provider === "modrinth") {
    for (const id of [target.slug, target.projectId].filter((value): value is string => !!value)) {
      const url = modrinthMavenUrl(id, target.modVersion, file.fileName);
      if (!candidates.some((candidate) => candidate.url === url)) {
        candidates.push({
          url,
          fileName: file.fileName,
          hashes: file.hashes,
          label: `Modrinth Maven (${id})`,
        });
      }
    }
  }
  return candidates;
}

async function downloadCandidate(
  candidates: DownloadCandidateSpec[],
  log?: (line: string) => void,
): Promise<string> {
  const errors: string[] = [];
  for (const candidate of candidates) {
    const dir = path.join(getModIntelDownloadRoot(), randomUUID());
    const dest = path.join(dir, safeDownloadName(candidate.fileName));
    try {
      log?.(`Downloading ${candidate.label ?? candidate.fileName}: ${candidate.url}`);
      await downloadFile(candidate.url, dest);
      await verifyFileHashes(dest, candidate.hashes);
      return dest;
    } catch (err) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      const reason = err instanceof Error ? err.message : String(err);
      errors.push(`${candidate.label ?? candidate.fileName}: ${reason}`);
      log?.(`Download candidate failed: ${reason}`);
    }
  }
  throw new Error(`All download candidates failed:\n- ${errors.join("\n- ")}`);
}

function isManagedDownloadFile(file: string | undefined): boolean {
  if (!file) return false;
  const root = path.resolve(getModIntelDownloadRoot());
  const target = path.resolve(file);
  const norm = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  return norm(target).startsWith(norm(root) + path.sep);
}

async function cleanupManagedDownload(file: string | undefined): Promise<void> {
  if (!file || !isManagedDownloadFile(file)) return;
  await fs.promises.rm(path.dirname(file), { recursive: true, force: true }).catch(() => {});
}

function orderedSourceCandidates(
  target: ModIntelResolvedTarget,
  preferred?: string,
): ModIntelSourceCandidate[] {
  const ordered: ModIntelSourceCandidate[] = [];
  if (preferred) {
    const exact = target.sourceCandidates.find((candidate) => candidate.sourceKind === preferred);
    if (exact) ordered.push(exact);
  }
  for (const candidate of target.sourceCandidates) {
    if (!ordered.includes(candidate) && candidate.sourceKind !== "cfr-decompile") ordered.push(candidate);
  }
  for (const candidate of target.sourceCandidates) {
    if (!ordered.includes(candidate) && candidate.sourceKind === "cfr-decompile") ordered.push(candidate);
  }
  return ordered;
}

function sourceKindConfidence(candidate?: ModIntelSourceCandidate): SourceConfidence {
  return candidate?.confidence ?? "medium";
}

function unitIdForEntry(entry: ModSourceEntry): string {
  return path.relative(getSourceVaultRoot(), entry.path).replace(/\\/g, "/");
}

function readableSourceDirForEntry(entry: ModSourceEntry): string {
  const readable = entry.layout?.readableSourcePath
    ?? (entry.sourceKind === "cfr-decompile" ? "decompiled-code" : "source-code");
  const readableDir = path.join(entry.path, readable);
  return fs.existsSync(readableDir) ? readableDir : entry.sourcePath;
}

class ModIntelManager {
  private task: ModIntelTaskSnapshot | null = null;

  status(): ModIntelStatus {
    fs.mkdirSync(getModIntelDownloadRoot(), { recursive: true });
    return {
      rootPath: getSourceVaultRoot(),
      task: this.task ? { ...this.task, logs: [...this.task.logs] } : null,
    };
  }

  startPrepare(request: ModIntelSourcePrepareRequest): ModIntelTaskSnapshot {
    if (this.task?.state === "running") throw new Error("Another external mod source task is already running.");
    const loader = request.loader || request.target.loader;
    const mcVersion = request.mcVersion || request.target.minecraftVersion;
    if (!isLoader(loader) || !mcVersion) throw new Error("Missing loader or Minecraft version.");
    this.task = {
      id: randomUUID(),
      state: "running",
      startedAt: new Date().toISOString(),
      phase: "resolving",
      target: {
        modId: request.target.modId,
        modName: request.target.modName,
        modVersion: request.target.modVersion,
        loader,
        mcVersion,
      },
      logs: [],
    };
    void this.runPrepare(request, loader, mcVersion);
    return { ...this.task, logs: [] };
  }

  private log(line: string): void {
    if (!this.task) return;
    this.task.logs.push(line.slice(0, 700));
    if (this.task.logs.length > MAX_TASK_LOGS) this.task.logs.splice(0, this.task.logs.length - MAX_TASK_LOGS);
  }

  private async runPrepare(
    request: ModIntelSourcePrepareRequest,
    loader: LoaderId,
    mcVersion: string,
  ): Promise<void> {
    if (!this.task) return;
    let artifactFile: string | undefined;
    let sourceArchiveFile: string | undefined;
    try {
      const target = request.target;
      const localArtifactPath = (target as ModIntelResolvedTarget & { localArtifactPath?: string }).localArtifactPath;
      const file = target.primaryFile;
      if (!localArtifactPath && !file?.url) throw new Error("The resolved target has no downloadable mod jar.");
      this.task.phase = "downloading";
      this.log(`Preparing ${target.modName} ${target.modVersion} for ${loader} ${mcVersion}`);
      artifactFile = localArtifactPath
        ?? await downloadCandidate(artifactDownloadCandidates(target, file!), (line) => this.log(line));
      this.log(`Mod jar ready: ${path.basename(artifactFile)}`);

      const metadata = detectModMetadata(artifactFile, target.modName, target.modVersion)
        ?? { modId: target.modId, modName: target.modName, modVersion: target.modVersion };
      let selectedSource: ModIntelSourceCandidate | undefined;
      for (const candidate of orderedSourceCandidates(target, request.preferredSourceKind)) {
        selectedSource = candidate;
        if (candidate.sourceKind === "cfr-decompile") {
          this.log("No source archive matched; CFR decompile will be used.");
          break;
        }
        try {
          if (candidate.path) {
            sourceArchiveFile = candidate.path;
          } else if (candidate.url) {
            const name = candidate.sourceKind === "github-source"
              ? `${metadata.modId}-${metadata.modVersion}-github.zip`
              : `${metadata.modId}-${metadata.modVersion}-sources.jar`;
            sourceArchiveFile = await downloadCandidate([{
              url: candidate.url,
              fileName: name,
              label: `${candidate.sourceKind} source`,
            }], (line) => this.log(line));
          }
          if (sourceArchiveFile) {
            const zip = new AdmZip(sourceArchiveFile);
            if (!zip.getEntries().some((entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith(".java"))) {
              throw new Error("Source archive contains no Java sources.");
            }
            this.log(`Source candidate: ${candidate.sourceKind} (${candidate.confidence})`);
            break;
          }
        } catch (err) {
          this.log(`Source candidate failed (${candidate.sourceKind}): ${(err as Error).message}`);
          await cleanupManagedDownload(sourceArchiveFile);
          selectedSource = undefined;
          sourceArchiveFile = undefined;
        }
      }
      if (!sourceArchiveFile && selectedSource?.sourceKind !== "cfr-decompile") {
        selectedSource = target.sourceCandidates.find((candidate) => candidate.sourceKind === "cfr-decompile")
          ?? {
            sourceKind: "cfr-decompile",
            provider: target.provider,
            confidence: "medium",
            reason: "fallback after source archive downloads failed",
          };
        this.log("Source archives were unavailable; CFR decompile will be used.");
      }

      this.task.phase = "materializing";
      const github = selectedSource?.repository;
      const entry = await materializeExternalModSource({
        loader,
        minecraftVersion: mcVersion,
        projectPath: request.projectPath,
        modId: metadata.modId,
        modName: metadata.modName,
        modVersion: metadata.modVersion,
        artifactFile,
        sourceArchiveFile,
        sourceArchiveKind: selectedSource?.sourceKind === "github-source" ? "github-source"
          : selectedSource?.sourceKind === "manual-source" ? "manual-source"
            : sourceArchiveFile ? "sources-jar" : undefined,
        origin: {
          provider: target.provider === "github" ? "github" : target.provider,
          url: file?.url,
          file: localArtifactPath,
          projectId: target.projectId,
          projectSlug: target.slug,
          versionId: target.selectedVersion?.id,
          version: target.modVersion,
          repositoryUrl: github?.repositoryUrl ?? target.sourceUrl,
          repositoryRef: github?.ref,
          commitSha: github?.commitSha,
        },
        license: target.license ? { id: target.license, source: "platform" } : undefined,
        confidence: sourceKindConfidence(selectedSource),
        force: request.force === true,
        log: (line) => this.log(line),
      });
      const unitId = unitIdForEntry(entry);
      const projection = request.projectPath
        ? await projectExternalModSource(request.projectPath, entry)
        : undefined;
      if (projection) this.log(`Project source linked: ${projection.modSourcePath}`);
      this.task.phase = "reporting";
      this.task.result = {
        unitId,
        path: entry.path,
        sourcePath: readableSourceDirForEntry(entry),
        projectSourcePath: projection?.rootPath,
        projectModSourcePath: projection?.modSourcePath,
        reportPath: entry.reportPath ? path.join(entry.path, entry.reportPath) : undefined,
        entry,
      };
      this.task.state = "completed";
      this.task.finishedAt = new Date().toISOString();
      this.task.phase = undefined;
      this.log(`Source unit ready: ${unitId}`);
    } catch (err) {
      if (!this.task) return;
      this.task.state = "failed";
      this.task.lastError = (err as Error).message;
      this.task.finishedAt = new Date().toISOString();
      this.task.phase = undefined;
      this.log((err as Error).message);
    } finally {
      await cleanupManagedDownload(sourceArchiveFile);
      await cleanupManagedDownload(artifactFile);
    }
  }
}

const manager = new ModIntelManager();

export function getModIntelStatus(): ModIntelStatus {
  return manager.status();
}

export function startModIntelSourceTask(request: ModIntelSourcePrepareRequest): ModIntelTaskSnapshot {
  return manager.startPrepare(request);
}

export function readSourceReport(unitId: string): { path: string; content: string } {
  const unitDir = resolveSourceUnitId(unitId);
  const manifest = JSON.parse(fs.readFileSync(path.join(unitDir, "manifest.json"), "utf8")) as ModSourceEntry;
  if (!manifest.reportPath) throw new Error("Source unit has no report.");
  const reportPath = path.join(unitDir, manifest.reportPath);
  return { path: reportPath, content: fs.readFileSync(reportPath, "utf8") };
}

export function sourceUnitPaths(unitId: string): { unitDir: string; sourceDir: string; reportPath?: string } {
  const unitDir = resolveSourceUnitId(unitId);
  const manifest = JSON.parse(fs.readFileSync(path.join(unitDir, "manifest.json"), "utf8")) as ModSourceEntry;
  const readableSourcePath = manifest.layout?.readableSourcePath
    ?? (manifest.sourceKind === "cfr-decompile" ? "decompiled-code" : "source-code");
  const readableSourceDir = path.join(unitDir, readableSourcePath);
  return {
    unitDir,
    sourceDir: fs.existsSync(readableSourceDir) ? readableSourceDir : path.join(unitDir, "src"),
    reportPath: manifest.reportPath ? path.join(unitDir, manifest.reportPath) : undefined,
  };
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function collectProfileFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(full);
    }
  };
  visit(root);
  return files;
}

export function listCompatibilityProfiles(projectPath: string, variantId?: string): CompatibilityProfile[] {
  const root = getCompatibilityRoot(projectPath);
  return collectProfileFiles(root)
    .map((file) => readJsonFile<CompatibilityProfile>(file))
    .filter((profile): profile is CompatibilityProfile =>
      !!profile && profile.schema === 1 && (!variantId || profile.variantId === variantId),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function upsertCompatibilityProfile(
  projectPath: string,
  variantId: string,
  input: {
    target: ModIntelResolvedTarget;
    sourceUnitId?: string;
    dependencySnippets?: string[];
    codeRefs?: string[];
    notes?: string;
  },
): Promise<CompatibilityProfile> {
  const loader = input.target.loader ?? "fabric";
  const mcVersion = input.target.minecraftVersion ?? "unknown";
  const file = compatibilityProfilePath(projectPath, input.target.modId, loader, mcVersion);
  const existing = readJsonFile<CompatibilityProfile>(file);
  const now = new Date().toISOString();
  const profile: CompatibilityProfile = {
    schema: 1,
    generatedAt: existing?.generatedAt ?? now,
    updatedAt: now,
    projectPath: path.resolve(projectPath),
    variantId,
    target: {
      modId: input.target.modId,
      modName: input.target.modName,
      modVersion: input.target.modVersion,
      provider: input.target.provider,
      loader: input.target.loader,
      minecraftVersion: input.target.minecraftVersion,
    },
    sourceUnitId: input.sourceUnitId ?? existing?.sourceUnitId,
    dependencyMode: "preview-only",
    dependencySnippets: input.dependencySnippets ?? input.target.dependencySnippets ?? existing?.dependencySnippets ?? [],
    codeRefs: input.codeRefs ?? existing?.codeRefs ?? [],
    notes: input.notes ?? existing?.notes ?? "",
    verification: existing?.verification ?? { status: "not-run" },
  };
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(profile, null, 2) + "\n", "utf8");
  return profile;
}
