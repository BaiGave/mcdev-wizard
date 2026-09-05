# 外部模组适配中心设计

## 背景

DMCL 现在已经有一条可用的“开发源码”链路：按当前变体准备 Minecraft 源码，解析 Gradle 前置依赖，优先提取依赖的 `-sources.jar`，没有源码包时使用 CFR 反编译，并把结果投影到项目 `.dmcl/sources` 目录。相关能力集中在 `src/sources/service.ts`、`src/sources/paths.ts`、`src/sources/types.ts`，GUI 已经通过 `/api/variants/:id/sources` 暴露“准备开发源码”按钮。

新的需求不是再做一个单独反编译按钮，而是把“我要适配某个外部模组”做成完整工作流：

1. 能知道目标模组来自哪里：当前项目依赖、本地 jar、Modrinth、CurseForge、GitHub、用户手动指定。
2. 有源码时优先使用真实源码，并尽量锁定到和 jar 版本一致的 tag/commit。
3. 没有源码时反编译 jar，保留 hash、版本、来源和反编译器信息。
4. 把源码、索引、报告、适配笔记、验证结果长期沉淀，后续项目和版本可以复用。
5. 最终帮助开发者快速回答：这个模组暴露了什么 API？我应该 compileOnly 还是 runtimeOnly？应该用事件、接口、反射、Mixin 还是软依赖？这个适配在不同 MC/Loader 版本下是否还能跑。

这里的“完美方案”定义为：可追溯、可复现、优先尊重真实源码、反编译只是兜底、适配结论能被构建和运行验证闭环。

## 现状可复用能力

- 源码仓库：`~/.dmcl/sources/v1`，已有 Minecraft 与模组源码单元目录结构。
- 依赖发现：通过临时 Gradle init script 解析 `compileClasspath`、`runtimeClasspath`、`modCompileClasspath`、`clientCompileClasspath`。
- 模组识别：读取 `fabric.mod.json`、`META-INF/mods.toml`、`META-INF/neoforge.mods.toml`、`mcmod.info`。
- 源码优先级：Maven/Gradle 缓存中的 `-sources.jar` 优先，否则 CFR 反编译。
- 投影入口：把 MC 与前置模组源码链接或复制到项目 `.dmcl/sources`，并写 `index.json`。
- GUI 入口：变体详情页可准备/打开开发源码，源码中心可批量准备 MC 源码。
- 构建基础：已有 build queue、version verifier、matrix，适合扩展成“带某个外部模组一起验证”。

## 主要缺口

- 没有平台级来源解析：无法从 Modrinth/CurseForge 页面或项目 ID 找 jar、版本、依赖、源码链接。
- 没有 GitHub 版本匹配：无法根据模组版本自动选择 tag、release、分支或 commit。
- 没有源码可信度模型：真实源码、sources jar、反编译源码都只表现为“源码”，缺少 origin、confidence、license、commit、artifact hash。
- 没有可检索索引：准备好的源码只能打开文件夹，不能快速检索 API、入口点、Mixin 目标、事件、注册表 ID。
- 没有适配知识模型：开发者为了某个目标模组做的软依赖、Mixin、反射、版本判断和验证结论没有沉淀。
- 没有兼容性验证：当前构建验证主要围绕自有变体，还没有“带目标模组 jar 运行一次”的验证任务。

## 总体方案

新增一个“外部模组适配中心”，内部名字建议为 `mod-intel`，中文 UI 可叫“适配中心”或“外部模组”。

整体分为五层：

1. **来源发现层**：从当前 Gradle 依赖、本地 jar、Modrinth、CurseForge、GitHub URL、手动文件输入中解析目标模组。
2. **源码获取层**：按优先级获取真实源码、sources jar、反编译源码，并写入统一源码仓库。
3. **索引分析层**：扫描源码和 jar，生成 API/类/方法/入口点/metadata/Mixin/Access Widener/许可证/依赖关系索引。
4. **适配知识层**：把某个自有变体对目标模组的适配策略、代码位置、依赖片段、验证结果保存成 profile。
5. **验证闭环层**：自动给 Gradle 注入目标模组，执行 build/runClient/log analysis，产出兼容状态。

推荐不要把这些都塞进现有 `src/sources`。`sources` 继续负责“源码物化和投影”，新增 `src/mod-intel` 负责“外部模组来源、索引、适配与验证”。两者通过稳定的 manifest 交互。

## 源码获取优先级

对一个目标模组版本，按以下顺序处理：

1. **项目已有依赖源码**：当前实现已经支持。若 Gradle 缓存里有 `-sources.jar`，直接提取。
2. **平台 metadata 的源码链接**：Modrinth 项目字段有 `source_url`，可指向 GitHub 等源码仓库；CurseForge 可作为带 API key 的增强来源。
3. **GitHub 仓库匹配**：如果拿到 GitHub URL，按版本号寻找 `vX.Y.Z`、`X.Y.Z`、`mcX.Y-Z`、release tag、默认分支，再读取 `gradle.properties`、mod metadata、release assets 校验。
4. **平台文件 jar**：从 Modrinth/CurseForge 或用户本地文件拿到目标 jar，保存 hash，并寻找同坐标 sources jar。
5. **CFR 反编译兜底**：只有找不到真实源码或 sources jar 时才反编译。反编译结果标记为 read-only reference，不建议复制代码。

关键原则：源码和 jar 必须尽量用 hash 或 commit 对齐。匹配不到完全一致时允许使用“近似源码”，但要在报告里显示置信度。

## 数据模型

扩展现有 `ModSourceEntry`，或新增更完整的 `ExternalModSourceManifest`：

```ts
interface ExternalModSourceManifest {
  schema: 1;
  modId: string;
  modName: string;
  modVersion: string;
  loader?: "fabric" | "forge" | "neoforge" | "unknown";
  minecraftVersions: string[];
  artifact: {
    path: string;
    sha256: string;
    size: number;
    maven?: { group: string; name: string; version: string };
  };
  sourceKind: "github-source" | "sources-jar" | "cfr-decompile" | "manual-source";
  origin: {
    provider: "gradle" | "local" | "modrinth" | "curseforge" | "github" | "manual";
    url?: string;
    projectId?: string;
    versionId?: string;
    fileId?: string;
  };
  repository?: {
    url: string;
    ref: string;
    commit?: string;
    matchedBy: "exact-tag" | "release" | "metadata-version" | "default-branch" | "manual";
  };
  confidence: "exact" | "high" | "medium" | "low";
  license?: {
    id?: string;
    name?: string;
    url?: string;
    source?: "platform" | "repo" | "jar" | "unknown";
  };
  decompiler?: { name: "CFR"; version: string };
  javaFiles: number;
  generatedAt: string;
  relativeSourcePath: "src";
}
```

建议目录继续复用源码仓库，但补充来源维度：

```text
~/.dmcl/sources/v1/
  mods/
    fabric/1.21.1/sodium/0.6.13/abcdef1234567890/
      manifest.json
      READY
      src/
      artifacts/
      index/
        symbols.json
        metadata.json
        api-report.md
```

适配 profile 单独存储：

```text
项目/.dmcl/compat/
  sodium/
    fabric-1.21.1.json
```

```ts
interface CompatibilityProfile {
  schema: 1;
  projectVariantId: string;
  targetMod: {
    modId: string;
    modVersion: string;
    artifactSha256: string;
    sourceUnitPath: string;
  };
  dependencyMode: "compileOnly" | "modCompileOnly" | "modRuntimeOnly" | "optionalRuntime" | "manual";
  strategy: Array<"public-api" | "events" | "capability" | "reflection" | "mixin" | "access-widener">;
  codeRefs: Array<{ file: string; symbol?: string; note?: string }>;
  verification: {
    state: "unknown" | "build-pass" | "run-pass" | "failed";
    lastRunAt?: string;
    logPath?: string;
    failureSummary?: string;
  };
  notes: string;
  updatedAt: string;
}
```

## 索引分析

源码准备完成后自动生成索引：

- `metadata.json`：mod id、loader、入口点、Mixin config、Access Widener、依赖声明、side 信息。
- `symbols.json`：包名、public/protected class、方法签名、字段、注解、继承关系。
- `targets.json`：Mixin target、被访问的 Minecraft 类、反射字符串、注册表 ID。
- `api-report.md`：给开发者看的摘要，按“可直接依赖的 API”“适合反射的类”“Mixin 风险点”“版本/Loader 限制”“许可证提醒”组织。

第一版可以只做轻量索引：正则 + Java 文件路径 + metadata JSON/TOML 解析。后续再考虑 Java parser 或 classfile parser。

## GUI 工作流

在变体详情页新增“适配其它模组”入口：

1. **选择目标**：从当前 Gradle 依赖自动列出，也允许输入 Modrinth/CurseForge/GitHub URL 或选择 jar。
2. **解析来源**：展示模组名、版本、MC 版本、loader、jar hash、源码来源候选。
3. **准备源码**：一键获取真实源码或反编译，并显示 `sourceKind` 与 `confidence`。
4. **查看报告**：直接打开 `api-report.md` 或源码目录。
5. **生成依赖片段**：按 loader 给出 `modCompileOnly`、`modRuntimeOnly`、`compileOnly` 等建议，不自动改 `build.gradle`，第一版先复制/插入前预览。
6. **保存适配 profile**：记录当前策略、备注、相关代码位置。
7. **运行兼容验证**：带目标 jar 执行 build/runClient，失败时把 NoClassDef、NoSuchMethod、Mixin apply failed、缺依赖等错误归因到 profile。

源码中心也要新增“外部模组”页签，用来查看已经缓存的目标模组源码、反编译来源、许可证和占用空间。

## API 草案

```text
GET  /api/mod-intel/status
POST /api/mod-intel/resolve
POST /api/mod-intel/sources
GET  /api/mod-intel/sources/:unitId
GET  /api/mod-intel/sources/:unitId/report
POST /api/mod-intel/sources/:unitId/open

GET  /api/variants/:id/compat
POST /api/variants/:id/compat
PATCH /api/variants/:id/compat/:targetModId
POST /api/variants/:id/compat/:targetModId/verify
```

`resolve` 输入可以是：

```ts
type ResolveInput =
  | { kind: "gradle-dependency"; projectPath: string }
  | { kind: "jar"; path: string }
  | { kind: "modrinth"; projectIdOrSlug: string; version?: string }
  | { kind: "curseforge"; projectId: number; fileId?: number }
  | { kind: "github"; url: string; version?: string };
```

## 模块划分

```text
src/mod-intel/
  types.ts
  manifest.ts
  resolver.ts
  artifact.ts
  platforms/
    modrinth.ts
    curseforge.ts
    github.ts
  source-materializer.ts
  indexer.ts
  report.ts
  compat-profile.ts
  compat-verify.ts
  index.ts
```

复用/改造点：

- 从 `src/sources/service.ts` 抽出可复用的 `sha256File`、`extractJavaSources`、`runCfr`、`detectModMetadata`、`findDependencySourcesArchive`。
- `src/sources` 保持 MC 源码与项目投影能力；`mod-intel` 调用它或共享底层工具。
- `gui/workspace-api.ts` 添加新 API 路由。
- `gui/renderer-src/boot.ts` 添加适配中心 UI。
- `tests/sources.test.ts` 可拆一部分为 `tests/mod-intel.test.ts`，覆盖 URL 解析、manifest、GitHub tag 匹配、反编译兜底、profile 保存。

## 兼容验证设计

第一版不要试图“智能修改代码”。更稳的是验证闭环：

1. 准备目标模组 jar 和必要依赖 jar。
2. 生成临时 Gradle init script，把目标 jar 以合适 configuration 加入当前变体。
3. 执行 `gradlew build`。
4. 可选执行 `runClient`，使用已有队列和日志归档能力。
5. 分析日志：
   - `NoClassDefFoundError`：依赖未放到运行时或 loader 不匹配。
   - `NoSuchMethodError` / `NoSuchFieldError`：目标模组版本 API 不兼容。
   - `Mixin apply failed`：Mixin target 变化或冲突。
   - Fabric `Incompatible mods found`：依赖约束冲突。
6. 写回 `CompatibilityProfile.verification`。

这样开发者每次升级目标模组或 MC 版本时，可以直接重新验证 profile，而不是重新摸一遍。

## 法务与安全边界

- 真实源码优先，反编译仅作为适配分析参考。
- manifest 必须记录来源、hash、反编译器、生成时间、license。
- UI 明确区分“官方源码 / sources jar / 反编译源码”。
- 不自动把反编译代码复制到项目源码。
- 对未知许可证显示警告：只能用于理解 API 和兼容性，不默认建议复制实现。
- 解压 jar/zip 继续使用安全路径校验，禁止 zip slip。
- GitHub/平台下载都要走现有 HTTP 重试、User-Agent、超时和缓存。

## 分阶段落地

### 第 1 阶段：把现有能力产品化

- 给现有 `ModSourceEntry` 补充 origin、artifact、confidence、license 字段。
- 把 CFR、源码提取、metadata 探测拆成可复用工具。
- 在 `.dmcl/sources/mods/.../index/` 生成最小 `metadata.json` 和 `api-report.md`。
- GUI 在“准备开发源码”结果里显示每个前置模组的来源：sources jar / CFR / 缓存。

### 第 2 阶段：Modrinth + GitHub 源码匹配

- 实现 Modrinth resolver，读取项目、版本、文件、依赖和 `source_url`。
- 实现 GitHub resolver，支持仓库 URL、tag/release/default branch 匹配、zip 下载、commit 记录。
- 对 Modrinth 上有 GitHub 的项目优先使用 GitHub 源码。
- 无 GitHub 或匹配失败时回到 sources jar / CFR。

### 第 3 阶段：适配 profile 与 UI

- 变体详情页新增“适配其它模组”。
- 保存 `CompatibilityProfile`。
- 支持打开源码、打开报告、记录备注、选择依赖模式。
- 第一版依赖片段只预览，不直接改 `build.gradle`。

### 第 4 阶段：兼容验证

- 新增 compat verify 任务，复用 build queue。
- 支持 build-only 和 build+runClient。
- 日志归因写回 profile。
- 矩阵页可显示“对某目标模组已验证/失败”。

### 第 5 阶段：CurseForge 与高级索引

- 支持 CurseForge API key 配置。
- 用 CurseForge 文件和依赖数据补足 Modrinth 找不到的模组。
- 增强 Java/class 索引，生成更有价值的 API 报告。
- 支持同一目标模组多版本 diff：API 变更、Mixin target 变更、依赖变更。

## 推荐的第一步实现

最小可交付版本建议这样做：

1. 在现有 `/api/variants/:id/sources` 任务完成后，为每个前置模组生成 `api-report.md`。
2. manifest 增加 `origin`、`artifact`、`confidence`。
3. GUI 源码准备完成弹窗列出前置模组及来源。
4. 新增一个“外部模组源码缓存”列表页，只读展示已缓存模组。

这一步风险最低，因为完全复用现有依赖解析和 CFR 链路，不需要平台 API，也不会影响项目生成/构建主流程。做完以后再接 Modrinth/GitHub，整个适配中心就顺理成章地长出来。

## 外部 API 依据

- Modrinth Project API 暴露 `source_url`，可作为优先寻找 GitHub 源码的入口。
- GitHub Contents/Archive API 支持读取仓库内容和下载 zip archive，适合按 tag/branch 拉源码快照。
- CurseForge API 需要 API key，可作为增强来源，不应成为第一阶段的硬依赖。

## Implemented v1 status - 2026-07-09

- Added `src/mod-intel` with Modrinth search/resolve, GitHub ref matching, external source preparation tasks, source report access, and compatibility profile persistence.
- Extended `src/sources` so external mod sources can share the same source vault, manifests, artifact records, CFR fallback, and API report generation as Gradle dependency sources.
- Added `/api/mod-intel/*` routes plus `/api/variants/:id/compat` routes in the GUI API layer.
- Added an Adaptation Center GUI view with Modrinth-style search filters, result details, source candidate selection, source preparation, report opening, dependency snippet copy, and variant-bound profile saving.
- CurseForge remains a reserved provider until API key configuration is implemented.
