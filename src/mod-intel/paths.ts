import path from "node:path";
import { getSourceVaultRoot, safeSourceSegment } from "../sources/paths.js";

export function getModIntelRoot(): string {
  return path.join(getSourceVaultRoot(), "mod-intel");
}

export function getModIntelDownloadRoot(): string {
  return path.join(getModIntelRoot(), "downloads");
}

export function getCompatibilityRoot(projectPath: string): string {
  return path.join(path.resolve(projectPath), ".dmcl", "compat");
}

export function compatibilityProfilePath(
  projectPath: string,
  modId: string,
  loader: string,
  mcVersion: string,
): string {
  return path.join(
    getCompatibilityRoot(projectPath),
    safeSourceSegment(modId),
    `${safeSourceSegment(loader)}-${safeSourceSegment(mcVersion)}.json`,
  );
}

export function resolveSourceUnitId(unitId: string): string {
  const root = path.resolve(getSourceVaultRoot());
  const normalized = unitId.replace(/\\/g, "/").split("/").filter(Boolean);
  if (normalized.some((part) => part === "..")) throw new Error("Invalid source unit id");
  const target = path.resolve(root, ...normalized);
  const norm = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (norm(target) !== norm(root) && !norm(target).startsWith(norm(root) + path.sep)) {
    throw new Error("Invalid source unit id");
  }
  return target;
}
