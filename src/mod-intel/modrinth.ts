import type { LoaderId } from "../types.js";
import { fetchJson } from "../core/http.js";
import type {
  ModIntelDependency,
  ModIntelFile,
  ModIntelSearchRequest,
  ModIntelSearchResponse,
  ModIntelSearchResult,
  ModIntelVersion,
} from "./types.js";

const API = "https://api.modrinth.com/v2";
const LOADER_CATEGORIES = new Set(["fabric", "forge", "neoforge"]);

interface ModrinthSearchHit {
  project_id: string;
  slug: string;
  title: string;
  description?: string;
  icon_url?: string;
  downloads?: number;
  follows?: number;
  categories?: string[];
  versions?: string[];
  license?: string;
  source_url?: string;
  date_modified?: string;
}

interface ModrinthSearchPayload {
  hits: ModrinthSearchHit[];
  offset: number;
  limit: number;
  total_hits: number;
}

interface ModrinthProject {
  id: string;
  slug?: string;
  title: string;
  description?: string;
  source_url?: string;
  license?: { id?: string; name?: string };
  loaders?: string[];
  game_versions?: string[];
}

interface ModrinthVersionFile {
  hashes?: Record<string, string>;
  url: string;
  filename: string;
  primary?: boolean;
  size?: number;
}

interface ModrinthDependency {
  project_id?: string;
  version_id?: string;
  file_name?: string;
  dependency_type: string;
}

interface ModrinthVersion {
  id: string;
  project_id: string;
  name?: string;
  version_number: string;
  game_versions?: string[];
  loaders?: string[];
  date_published?: string;
  files?: ModrinthVersionFile[];
  dependencies?: ModrinthDependency[];
}

export function buildModrinthSearchUrl(request: ModIntelSearchRequest): string {
  const params = new URLSearchParams();
  const query = (request.query ?? "").trim();
  if (query) params.set("query", query);
  params.set("index", request.sort ?? "relevance");
  params.set("offset", String(Math.max(0, request.offset ?? 0)));
  params.set("limit", String(Math.min(100, Math.max(1, request.limit ?? 20))));
  const facets: string[][] = [["project_type:mod"]];
  if (request.loader) facets.push([`categories:${request.loader}`]);
  if (request.mcVersion) facets.push([`versions:${request.mcVersion}`]);
  if (request.category) facets.push([`categories:${request.category}`]);
  params.set("facets", JSON.stringify(facets));
  return `${API}/search?${params.toString()}`;
}

function normalizeLoaders(categories?: string[], explicit?: string[]): LoaderId[] {
  const out = new Set<LoaderId>();
  for (const value of [...(categories ?? []), ...(explicit ?? [])]) {
    if (LOADER_CATEGORIES.has(value)) out.add(value as LoaderId);
  }
  return [...out];
}

function normalizeSearchHit(hit: ModrinthSearchHit): ModIntelSearchResult {
  return {
    provider: "modrinth",
    projectId: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    iconUrl: hit.icon_url,
    downloads: hit.downloads,
    follows: hit.follows,
    categories: hit.categories ?? [],
    loaders: normalizeLoaders(hit.categories),
    versions: hit.versions ?? [],
    license: hit.license,
    sourceUrl: hit.source_url,
    openSource: !!hit.source_url,
    updatedAt: hit.date_modified,
  };
}

export async function searchModrinth(request: ModIntelSearchRequest): Promise<ModIntelSearchResponse> {
  const payload = await fetchJson<ModrinthSearchPayload>(buildModrinthSearchUrl(request));
  return {
    provider: "modrinth",
    totalHits: payload.total_hits,
    offset: payload.offset,
    limit: payload.limit,
    results: payload.hits.map(normalizeSearchHit),
    warnings: [],
  };
}

function normalizeFile(file: ModrinthVersionFile): ModIntelFile {
  return {
    fileName: file.filename,
    url: file.url,
    primary: file.primary,
    size: file.size,
    hashes: file.hashes,
  };
}

function normalizeVersion(version: ModrinthVersion): ModIntelVersion {
  return {
    id: version.id,
    versionNumber: version.version_number,
    name: version.name,
    loaders: version.loaders ?? [],
    gameVersions: version.game_versions ?? [],
    datePublished: version.date_published,
    files: (version.files ?? []).map(normalizeFile),
    dependencies: (version.dependencies ?? []).map((dep): ModIntelDependency => ({
      projectId: dep.project_id,
      versionId: dep.version_id,
      fileName: dep.file_name,
      dependencyType: dep.dependency_type,
    })),
  };
}

export async function getModrinthProject(projectIdOrSlug: string): Promise<ModrinthProject> {
  return fetchJson<ModrinthProject>(`${API}/project/${encodeURIComponent(projectIdOrSlug)}`);
}

export async function getModrinthVersions(projectIdOrSlug: string): Promise<ModIntelVersion[]> {
  const versions = await fetchJson<ModrinthVersion[]>(`${API}/project/${encodeURIComponent(projectIdOrSlug)}/version`);
  return versions.map(normalizeVersion);
}

export function pickModrinthVersion(
  versions: ModIntelVersion[],
  opts: { versionId?: string; versionNumber?: string; loader?: LoaderId; mcVersion?: string },
): ModIntelVersion | undefined {
  const sorted = [...versions].sort((a, b) =>
    (b.datePublished ?? "").localeCompare(a.datePublished ?? ""),
  );
  return sorted.find((version) => {
    if (opts.versionId && version.id !== opts.versionId) return false;
    if (opts.versionNumber && version.versionNumber !== opts.versionNumber) return false;
    const loaderOk = !opts.loader || version.loaders.includes(opts.loader);
    const mcOk = !opts.mcVersion || version.gameVersions.includes(opts.mcVersion);
    return loaderOk && mcOk;
  });
}

export function pickPrimaryModrinthFile(version: ModIntelVersion): ModIntelFile | undefined {
  const files = version.files.filter((file) => file.fileName.toLowerCase().endsWith(".jar"));
  return files.find((file) => file.primary && !file.fileName.toLowerCase().includes("sources"))
    ?? files.find((file) => !file.fileName.toLowerCase().includes("sources"))
    ?? files[0];
}

export function pickSourceModrinthFile(version: ModIntelVersion): ModIntelFile | undefined {
  return version.files.find((file) => /-sources\.jar$/i.test(file.fileName));
}

export function modrinthLicense(project: ModrinthProject): string | undefined {
  return project.license?.id || project.license?.name;
}
