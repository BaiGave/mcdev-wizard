# DMCL integration review — 2026-09-05

## Scope

Reviewed `c/scaffold-boundary` and the pending DMCL changes against
`master` / `origin/master` at `8f0874d`. The existing scaffold guard commit
`c300b9c` is included. This review and delivery concern only the DMCL repository.

The pending work adds the adaptation center, Modrinth discovery, GitHub source
matching, source reports and profiles, selective runtime-mod sources, source
cache repair, and Gradle cache cleanup. These features are retained.

## Findings fixed before integration

| Area | Reproduced issue | Correction |
| --- | --- | --- |
| Modrinth selection | Missing loader/MC matches silently selected another release; explicit versions bypassed filters. | Require all requested filters to match the same release. |
| GitHub provenance | Downloads used a movable ref after recording its commit SHA. | Download the resolved SHA when available. |
| Source fallback | An archive without Java stopped the task before trying another valid source. | Validate candidate archives and continue to the next source. |
| Source projection | Concurrent writers lost mod entries or produced invalid JSON. | Serialize writes per project and merge the latest index while holding the write slot. |
| Git worktrees | Generated sources were excluded in the private worktree Git directory, which Git did not use. | Resolve `commondir` and write the shared exclusion file. |
| Windows cache replacement | Failed copy fallback left an incomplete replacement instead of restoring the old source unit. | Remove the failed replacement and restore the previous unit. |
| Gradle cache cleanup | A cache-root junction allowed cleanup to delete files outside its managed tree. | Refuse symbolic-link/junction roots as well as nested links. |
| Adaptation UI | Late search responses overwrote newer results; late detail responses reopened a result after returning to the list. | Ignore responses and failures from obsolete requests. |
| Dependency snippets | NeoForge and Forge received Fabric's `modImplementation` configuration. | Select the dependency declaration for the loader and Forge generation. |
| Delivery scope | Temporary downloads and nested development checkouts could enter Git or a packaged release. | Ignore local worktrees/downloads in Git and exclude projects, worktrees, and temporary files from packaging. |

## Validation

- Baseline: 81 tests passed.
- Final: `npm test` passed all 90 tests across 40 suites, including backend TypeScript compilation.
- `npm run gui:build` passed the Electron-side TypeScript build and renderer bundle generation.
- New regressions were run before their fixes and failed for the corresponding reasons above.
- Source filesystem tests use temporary fixtures, including a temporary Git worktree and injected Windows copy failures.
- Renderer request tests execute the production request functions with controlled response ordering; they do not operate the desktop UI.
- `git diff --check` passed.

The earlier direct-Node check of stale CommonJS files under `src/` is not a
failure of the supported `tsx` entry point or compiled `dist/` workflow. No
unrelated generated source files were removed on that basis.

## Verification limits

No mouse or keyboard automation, desktop screenshots, interactive GUI launch,
Minecraft client launch, or complete loader/version build matrix was performed.
No new installer was produced. Passing these checks establishes the reviewed
code and regression behavior, not universal mod or loader compatibility.

CurseForge remains a reserved provider. Compatibility profiles remain previews;
the changes do not add automated compatibility verification.
