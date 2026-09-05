import { fetchJson } from "../core/http.js";
import type { GithubSourceCandidate } from "./types.js";

interface GithubRepoPayload {
  html_url: string;
  default_branch: string;
  license?: { spdx_id?: string; name?: string };
}

interface GithubTagPayload {
  name: string;
  commit?: { sha?: string };
}

interface GithubCommitPayload {
  sha: string;
}

export interface ParsedGithubUrl {
  owner: string;
  repo: string;
  ref?: string;
}

export function parseGithubUrl(rawUrl: string): ParsedGithubUrl | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  let ref: string | undefined;
  if (parts[2] === "tree" || parts[2] === "blob" || parts[2] === "commit") {
    ref = parts.slice(3).join("/");
  } else if (parts[2] === "releases" && parts[3] === "tag") {
    ref = parts.slice(4).join("/");
  }
  return { owner, repo, ref: ref || undefined };
}

function normalizeVersion(value: string): string {
  return value.toLowerCase().replace(/^v/, "").replace(/[^a-z0-9]+/g, "");
}

function pickTag(tags: GithubTagPayload[], version?: string): GithubTagPayload | undefined {
  if (!version) return undefined;
  const wanted = normalizeVersion(version);
  return tags.find((tag) => normalizeVersion(tag.name) === wanted)
    ?? tags.find((tag) => normalizeVersion(tag.name).includes(wanted));
}

function pickExactTag(tags: GithubTagPayload[], version?: string): GithubTagPayload | undefined {
  if (!version) return undefined;
  const wanted = normalizeVersion(version);
  return tags.find((tag) => normalizeVersion(tag.name) === wanted);
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value && !!value.trim()))];
}

function minecraftVersionsFrom(value?: string): string[] {
  if (!value) return [];
  const versions = new Set<string>();
  const pattern = /(?:^|[^0-9])(\d+\.\d+(?:\.\d+)?)(?:[^0-9]|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) versions.add(match[1]);
  return [...versions];
}

function branchCandidates(opts: { version?: string; mcVersion?: string; loader?: string }): string[] {
  const versions = unique([opts.mcVersion, ...minecraftVersionsFrom(opts.version)]);
  const candidates: string[] = [];
  for (const version of versions) {
    candidates.push(
      `${version}/stable`,
      `${version}/dev`,
      version,
      `mc${version}`,
      `mc${version}/stable`,
    );
    if (opts.loader) {
      candidates.push(`${version}/${opts.loader}`, `mc${version}/${opts.loader}`);
    }
  }
  return unique(candidates);
}

export function githubArchiveUrl(owner: string, repo: string, ref: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball/${encodeURIComponent(ref)}`;
}

async function commitSha(owner: string, repo: string, ref: string): Promise<string | undefined> {
  try {
    const payload = await fetchJson<GithubCommitPayload>(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
      { retries: 0 },
    );
    return payload.sha;
  } catch {
    return undefined;
  }
}

export async function resolveGithubSource(
  rawUrl: string,
  opts: { version?: string; mcVersion?: string; loader?: string } = {},
): Promise<GithubSourceCandidate | null> {
  const parsed = parseGithubUrl(rawUrl);
  if (!parsed) return null;
  const repoPayload = await fetchJson<GithubRepoPayload>(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
  );
  let ref = parsed.ref;
  let confidence: GithubSourceCandidate["confidence"] = "high";
  let reason = "explicit GitHub ref";
  let sha: string | undefined;

  if (!ref) {
    const tags = await fetchJson<GithubTagPayload[]>(
      `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/tags?per_page=100`,
      { retries: 0 },
    ).catch(() => [] as GithubTagPayload[]);
    const exactTag = pickExactTag(tags, opts.version);
    if (exactTag) {
      ref = exactTag.name;
      sha = exactTag.commit?.sha;
      confidence = "exact";
      reason = `matched tag ${exactTag.name}`;
    }
    if (!ref) {
      for (const candidate of branchCandidates(opts)) {
        const candidateSha = await commitSha(parsed.owner, parsed.repo, candidate);
        if (!candidateSha) continue;
        ref = candidate;
        sha = candidateSha;
        confidence = "high";
        reason = `matched Minecraft branch ${candidate}`;
        break;
      }
    }
    if (!ref) {
      const tag = pickTag(tags, opts.version);
      if (tag) {
        ref = tag.name;
        sha = tag.commit?.sha;
        confidence = "medium";
        reason = `matched tag ${tag.name}`;
      } else {
        ref = repoPayload.default_branch;
        confidence = "low";
        reason = `fallback to default branch ${repoPayload.default_branch}`;
      }
    }
  }

  if (!sha) sha = await commitSha(parsed.owner, parsed.repo, ref);
  return {
    provider: "github",
    repositoryUrl: repoPayload.html_url,
    owner: parsed.owner,
    repo: parsed.repo,
    ref,
    commitSha: sha,
    archiveUrl: githubArchiveUrl(parsed.owner, parsed.repo, sha ?? ref),
    confidence,
    reason,
    license: repoPayload.license?.spdx_id || repoPayload.license?.name,
  };
}
