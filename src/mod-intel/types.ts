import type { LoaderId } from "../types.js";
import type { ModSourceEntry, SourceConfidence } from "../sources/types.js";

export type ModIntelProvider = "modrinth" | "curseforge" | "github" | "local" | "gradle" | "manual";
export type ModIntelSort = "relevance" | "downloads" | "follows" | "newest" | "updated";
export type ModIntelSourceKind = "github-source" | "sources-jar" | "manual-source" | "cfr-decompile";
export type ModIntelTaskState = "running" | "completed" | "failed" | "cancelled";

export interface ModIntelSearchRequest {
  query?: string;
  source?: "all" | "modrinth" | "curseforge";
  loader?: LoaderId;
  mcVersion?: string;
  category?: string;
  sort?: ModIntelSort;
  offset?: number;
  limit?: number;
}

export interface ModIntelSearchResult {
  provider: "modrinth" | "curseforge";
  projectId: string;
  slug?: string;
  title: string;
  description?: string;
  iconUrl?: string;
  downloads?: number;
  follows?: number;
  categories: string[];
  loaders: LoaderId[];
  versions: string[];
  license?: string;
  sourceUrl?: string;
  openSource: boolean;
  updatedAt?: string;
}

export interface ModIntelSearchResponse {
  provider: "modrinth";
  totalHits: number;
  offset: number;
  limit: number;
  results: ModIntelSearchResult[];
  warnings: string[];
}

export interface ModIntelDependency {
  projectId?: string;
  versionId?: string;
  fileName?: string;
  dependencyType: "required" | "optional" | "incompatible" | "embedded" | string;
}

export interface ModIntelFile {
  fileName: string;
  url: string;
  primary?: boolean;
  size?: number;
  hashes?: Record<string, string>;
}

export interface ModIntelVersion {
  id: string;
  versionNumber: string;
  name?: string;
  loaders: string[];
  gameVersions: string[];
  datePublished?: string;
  files: ModIntelFile[];
  dependencies: ModIntelDependency[];
}

export interface GithubSourceCandidate {
  provider: "github";
  repositoryUrl: string;
  owner: string;
  repo: string;
  ref: string;
  commitSha?: string;
  archiveUrl: string;
  confidence: SourceConfidence;
  reason: string;
  license?: string;
}

export interface ModIntelSourceCandidate {
  sourceKind: ModIntelSourceKind;
  provider: ModIntelProvider;
  url?: string;
  path?: string;
  confidence: SourceConfidence;
  reason: string;
  repository?: GithubSourceCandidate;
}

export interface ModIntelResolvedTarget {
  provider: ModIntelProvider;
  projectId?: string;
  slug?: string;
  title: string;
  modId: string;
  modName: string;
  modVersion: string;
  loader?: LoaderId;
  minecraftVersion?: string;
  license?: string;
  projectUrl?: string;
  sourceUrl?: string;
  selectedVersion?: ModIntelVersion;
  primaryFile?: ModIntelFile;
  localArtifactPath?: string;
  sourceCandidates: ModIntelSourceCandidate[];
  dependencySnippets: string[];
}

export type ModIntelResolveRequest =
  | {
    kind: "modrinth";
    projectIdOrSlug: string;
    versionId?: string;
    versionNumber?: string;
    loader?: LoaderId;
    mcVersion?: string;
  }
  | {
    kind: "github";
    url: string;
    version?: string;
  }
  | {
    kind: "jar" | "local";
    path: string;
    version?: string;
    loader?: LoaderId;
    mcVersion?: string;
  }
  | {
    kind: "gradle-dependency";
    projectPath?: string;
    file?: string;
    group?: string;
    name?: string;
    version?: string;
    loader?: LoaderId;
    mcVersion?: string;
  };

export interface ModIntelSourcePrepareRequest {
  target: ModIntelResolvedTarget;
  loader: LoaderId;
  mcVersion: string;
  projectPath?: string;
  force?: boolean;
  preferredSourceKind?: ModIntelSourceKind;
}

export interface ModIntelTaskSnapshot {
  id: string;
  state: ModIntelTaskState;
  startedAt: string;
  finishedAt?: string;
  phase?: "resolving" | "downloading" | "materializing" | "reporting";
  target?: {
    modId: string;
    modName: string;
    modVersion: string;
    loader: LoaderId;
    mcVersion: string;
  };
  result?: {
    unitId: string;
    path: string;
    sourcePath: string;
    projectSourcePath?: string;
    projectModSourcePath?: string;
    reportPath?: string;
    entry: ModSourceEntry;
  };
  lastError?: string;
  logs: string[];
}

export interface ModIntelStatus {
  rootPath: string;
  task: ModIntelTaskSnapshot | null;
}

export interface CompatibilityProfile {
  schema: 1;
  generatedAt: string;
  updatedAt: string;
  projectPath: string;
  variantId: string;
  target: {
    modId: string;
    modName: string;
    modVersion: string;
    provider: ModIntelProvider;
    loader?: LoaderId;
    minecraftVersion?: string;
  };
  sourceUnitId?: string;
  dependencyMode: "preview-only";
  dependencySnippets: string[];
  codeRefs: string[];
  notes: string;
  verification: {
    status: "not-run" | "passed" | "failed";
    lastRunAt?: string;
    summary?: string;
  };
}
