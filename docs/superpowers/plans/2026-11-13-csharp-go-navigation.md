# Orca C# and Go Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** 在 Orca 中提供 C# 和 Go 文件编辑及基于 LSP 的语义导航。

**Architecture:** 参考 JumpLens 的 Orca 文档会话、panel 通信和 CodeMirror 编辑器；使用独立 worker 管理按项目和语言隔离的 LSP 服务。通过 Orca CLI 打开工作区目标，使用宿主文档会话管理保存。

**Tech Stack:** TypeScript、Node.js、CodeMirror 6、Orca plugin API、LSP、gopls、csharp-ls、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-13-csharp-go-navigation-design.md`

## Global Constraints

- Orca >= 1.4.248；本地工作区；`.cs`、`.go`。
- 不自动下载语言服务或 SDK；缺失服务时编辑和保存仍可用。
- 不实现 Git 提交阅读、跨语言业务映射或非本地工作区支持。
- 遵守 JumpLens MIT 许可证；复用源码时保留版权及许可声明。
- 不执行 git commit，除非用户明确要求；当前目录不是 Git 仓库。
- csharp-ls 当前版本需要 .NET 10 SDK 或更高版本。

## 文件结构

- `orca-plugin.json`：自定义编辑器和设置。
- `package.json`、`tsconfig.json`、构建配置：依赖、构建与测试入口。
- `editor/main.ts`、`editor/sync.ts`、`editor/index.html`：CodeMirror 和 Orca 文档会话。
- `src/project.ts`：工作区、文件身份、项目根查找。
- `src/language-server.ts`：进程、LSP 连接、文档版本及请求。
- `src/worker.ts`：panel 通信、服务管理、导航和 CLI 打开。
- `tests/`：项目识别、LSP、导航及错误处理测试。
- `README.md`、`LICENSE`：安装、依赖、操作与许可证。

### Task 1: 取得可构建的 Orca 编辑器基线

**Files:** `orca-plugin.json`, `package.json`, `tsconfig.json`, `editor/`, `src/`, `LICENSE`。

**Interfaces:** `orca.document.session<string>()` 管理文档；`orca.plugin.request(name, input, options)` 与 `orca.panels.handle(name, handler)` 通信。

- [ ] 检查参考仓库固定提交 `b607ae52ba82ac4b59c41660679f1741b83c7b77` 的清单、依赖、编辑器和许可证。参考来源通过 GitHub API 读取；下载文件放独立空目录，不在该目录执行脚本。
- [ ] 从参考项目引入需要的编辑器和构建代码，保留适用 MIT 版权声明；移除 Java、Vue、JS/TS 语言服务和提交阅读相关入口。只注册 `.cs` 和 `.go`，保持 `execution: trusted-worker`、`frame: isolated`。
- [ ] 增加 CodeMirror C#、Go 语言支持，确认行号、折叠、括号补全、Tab 缩进、搜索替换、撤销重做以及宿主文档同步可用；只读文档不可编辑。示例会话接口：

```ts
const doc = orca.document.session<string>();
// 编辑发生时：doc.change(editor.state.doc.toString())。
// 宿主替换时：doc.onReplace(...)；关闭时：doc.dispose()。
```

- [ ] 安装锁定依赖并运行 `npm run build`、`npm run typecheck` 和编辑器同步测试；用 `orca plugin test . --json` 验证清单与宿主会话。记录实际测试结果。

### Task 2: 项目和文档身份

**Files:** `src/project.ts`, `tests/project.test.ts`。

**Interfaces:** `resolveDocument(workspace: string, text: string, extension: '.cs' | '.go'): Promise<string[]>` 返回工作区内候选绝对路径；`findProjectRoot(file: string, workspace: string): Promise<string>` 返回限定在工作区内的项目根目录。

- [ ] 先编写临时目录测试：完全匹配文件、同内容多候选、无匹配、Go `go.work`/`go.mod` 和 C# `.sln`/`.slnx`/`.csproj` 根查找，禁止解析到工作区外。运行 `npm test -- project`，确认测试先失败。
- [ ] 实现匹配与根查找；同内容多个候选交给用户选择，不猜测路径。使用真实路径检查工作区边界，跳过符号链接逃逸。宿主未提供路径时参考 JumpLens 的工作区识别机制。
- [ ] 重新运行 `npm test -- project`，确认全部通过。

### Task 3: LSP 生命周期与文档同步

**Files:** `src/language-server.ts`, `tests/language-server.test.ts`, `tests/fixtures/mock-lsp.*`。

**Interfaces:** `LanguageServer.start(root, executable)`, `open(uri, languageId, text)`, `change(uri, text)`, `request(method, params)`, `close(uri)`, `dispose()`；按语言和项目根分别实例化。

- [ ] 用本地模拟 LSP 进程测试 initialize/initialized、didOpen、版本递增的全文 didChange、didClose、请求/响应、超时、进程退出和重连。先运行测试并确认失败。
- [ ] 使用成熟 JSON-RPC/LSP 客户端处理 Content-Length 分帧、UTF-8 字节长度及服务器反向请求；协商 UTF-16 位置编码。启动时 C# 命令为配置值或 `csharp-ls`，Go 命令为配置值或 `gopls`，子进程工作目录为项目根。
- [ ] 重连时终止旧进程、拒绝悬挂请求并重新打开当前文档；确保未保存文本先于导航请求同步。服务缺失和不支持方法产生可展示的错误。
- [ ] 运行 `npm test -- language-server` 和 `npm run typecheck`；确认通过。

### Task 4: 导航与 Orca 打开

**Files:** `src/worker.ts`, `editor/main.ts`, `tests/navigation.test.ts`。

**Interfaces:** panel 请求 `attach`, `sync`, `navigate`, `open`, `reconnect`；导航方法映射 `textDocument/definition`、`textDocument/typeDefinition`、`textDocument/implementation`、`textDocument/references`。

- [ ] 先测试 LSP `Location`、`LocationLink`、空结果、多结果、UTF-16 中文及 emoji、过期文档版本、返回/前进和工作区外目标；运行 `npm test -- navigation` 确认失败。
- [ ] 将目标规范化为 URI、零基行列和预览文本；对于候选 URI 维护本次查询允许列表，校验真实路径在工作区内。超出工作区或非 file URI 时显示无法打开提示。
- [ ] 打开之前 `await doc.flush()`；worker 用参数数组调用 `orca file open <绝对路径> --line <一基行> --column <一基列> --worktree <selector> --focus --json`，避免 shell 拼接。按 JumpLens 的 panel `reveal` 机制处理已有及新面板的目标光标。
- [ ] 支持 F12、Ctrl/Cmd+点击、工具栏四类导航、结果筛选预览、历史前进后退；旧文档版本或过期请求的结果不得覆盖当前状态。
- [ ] 运行 `npm test -- navigation`、`npm run typecheck` 与 `npm run build`，确认通过。

### Task 5: 发布验证和文档

**Files:** `README.md`, `orca-plugin.json`, 集成测试及示例工程。

**Interfaces:** 配置项 `csharpServerPath` 和 `goServerPath`，空值表示从 PATH 查找。

- [ ] 编写 README：Orca 安装方式、`.NET 10 SDK`、`dotnet tool install --global csharp-ls`、Go、`go install golang.org/x/tools/gopls@latest`、服务路径设置、快捷键和已知限制。明确安装或下载依赖需用户自行决定。
- [ ] 为 C# 和 Go 创建包含跨文件定义、实现、引用、Unicode 和未保存修改的测试工程；使用真实服务测试四类导航。缺少服务时跳过并报告，不把模拟结果当作真实集成验证。
- [ ] 运行 `npm test`、`npm run typecheck`、`npm run build`、`orca plugin test . --json`；若 Orca 可交互，验证实际编辑、保存、外部修改冲突和跳转。记录命令及结果。
- [ ] 检查打包产物与许可证，向用户说明安装步骤和所有未验证项。
