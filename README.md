# Orca C# / Go Editor

Orca 本地工作区的 `.cs` / `.go` 自定义编辑器，使用 CodeMirror 和外部 LSP（`csharp-ls` / `gopls`）提供语言内导航。当前版本是开发版：真实 Orca 界面、真实语言服务和端到端跳转尚未验证；模拟测试通过不代表这些场景可用。不支持远程工作区、跨语言映射或 Git 提交阅读。

**已知问题：**重复绑定失败的未保存文档可能导致其他面板查询使用旧内容；跨项目查询后外部文件变更时旧结果可能仍可打开；重连失败后关闭并重新绑定，可能需要再次重连才能查询。请勿依赖导航结果的完整性或准确性；发布版本仍需修复并完成真实环境验证。

## 安装和权限

需要 Orca **1.4.248 或更新版本**、本地工作区；从源码构建还需要 Node.js 和 npm。取得可信源码后，在插件目录执行：

```sh
npm ci
orca plugin types . --json
npm run build
orca plugin inspect . --json
orca plugin install . --json
```

`npm ci` 会下载项目依赖；是否联网、安装插件和批准权限均由用户决定。若 Orca 返回 `approval_required`，检查其显示的源码、权限和指纹，仅在信任后使用其给出的 `--approve <fingerprint>` 命令重试；不要复用过期指纹。实际安装、审批及 UI 尚未实测。构建产生的 `dist/` 包含编辑器、worker、MIT 许可证及第三方许可声明；安装时保留插件清单和整个构建产物。对开发目录的 inspect 曾报告 637 个文件、约 45 MB，直接安装前应检查目录中全部文件及是否含本地数据；发布时应使用经过检查的精简目录，不要假设只包含 `dist/`。

清单声明 `trusted-worker`、隔离的编辑器 frame、`settings:own`（读写自身设置）及 `workspace:read`（读取工作区信息）。隔离 frame **不意味着 worker 沙箱化**：worker 运行可信 Node 代码、扫描工作区、读取候选和预览、启动语言服务，并调用本机 Orca CLI 打开文件。语言服务也以用户权限运行，可能执行项目构建/恢复及访问网络；只对可信插件、项目和服务授权。切勿把不可信可执行文件配置成服务。

## 安装语言服务和配置

本插件不会安装或下载 SDK / 语言服务。手动安装前请审阅上游说明，以下是用户自行选择执行的示例，不会由插件自动运行：

- C#：安装 [.NET 10 SDK 或更新版本](https://dotnet.microsoft.com/download)，然后 `dotnet tool install --global csharp-ls`。[csharp-ls 上游 Quick Start](https://github.com/razzmatazz/csharp-language-server#quick-start) 当前明确要求 .NET 10 SDK 或更高；这不是说目标项目必须使用 .NET 10。项目自身可能另需对应 SDK / targeting packs。
- Go：安装 [Go](https://go.dev/doc/install)，然后 `go install golang.org/x/tools/gopls@latest`。Go 和 gopls 的版本兼容性参阅 [gopls 安装说明](https://go.dev/gopls/)。

确保 Orca 进程的 PATH 能找到 `csharp-ls`、`dotnet`、`gopls` 和 `go`（全局工具目录也须在 PATH 中），或在 Orca 的此插件设置中将 `csharpServerPath` / `goServerPath` 分别设为服务可执行文件的完整路径；空字符串使用 PATH。设置仅指定可执行文件，不是带参数的命令行。SDK 仍须由服务找到。修改后使用 **Reconnect**；启动失败也可以重新绑定。服务缺失不应阻止基本编辑和由 Orca 管理的保存。

## 使用与限制

1. 在 Orca 本地工作区打开 `.cs` 或 `.go` 文件并选择 C# / Go Editor。宿主未必提供可信文件路径及文本类型；类型不可用时语法默认 C#，可手动用 **Syntax** 切换。
2. 点击 **Bind file**，选择 Workspace 和 File type，点击 **Scan**。无论是否只有一个同内容候选，都必须自己确认实际文件；相同内容不证明文件身份。扫描不完整时会列出跳过目录/错误，不能认为候选唯一。
3. 选择实际 File，点击 **Find projects**，选择正确 Project（也可能有工作区回退），再点 **Confirm binding**。绑定错误会让语言服务获得错误的文件身份，请重新绑定。每个目标编辑器也必须完成这一流程。
4. 在光标处用工具栏 **Definition / Type / Implementation / References** 查询；**F12** 或 **Ctrl+点击**（macOS 为 **Cmd+点击**）查询定义。单项直接请求打开，多项可按路径筛选并选择、查看预览、打开。预览读取的是磁盘文件，不保证包含未保存编辑。打开前等待宿主 `flush`；保存冲突或失败会中止打开。
5. 打开目标后并不自动证明目标面板的文件身份或自动恢复光标。目标面板显式绑定正确文件后，在 **Pending navigation** 选择具体待处理项，点击 **Go to selected location** 才领取坐标和历史。待处理项只能领取一次，保存在 worker 内存，重启后消失，当前没有数量或过期限制。Back / Forward 跨文件同样需要在目标面板绑定并领取后续交接；历史仅驻留内存。实际 Orca 对新旧面板及光标定位的行为尚未交互验证。

编辑器提供行号、折叠、括号补全、Tab 缩进、搜索/替换、撤销/重做；常用 CodeMirror 快捷键如 Ctrl/Cmd+F、Ctrl/Cmd+Z 受平台和宿主快捷键影响。宿主只读文件不可编辑；**混合换行文件强制只读**，以免序列化改变换行。请先在外部安全地统一换行，再让宿主重新载入。发生外部冲突时保留外部版本，并在编辑器中显示本地草稿供复制或另存；不会自动将草稿覆盖外部版本。草稿仅保存在当前面板内，关闭或崩溃前必须复制或另存；关闭提示及另存功能是否可用取决于宿主，真实 UI 尚未验证。宿主替换使用 CodeMirror 事务而非重建状态，但与外部修改重叠的撤销历史可能无法保留。

## 错误与安全边界

状态栏显示启动、同步、超时、无结果或不支持操作等错误。确认服务和 SDK、项目加载及路径后重连；某些服务不支持所请求的 LSP 方法。插件尝试同步未保存文本；如同项目中任一打开文档未同步，将拒绝相关查询。同工作区同语言的其他项目根中，已绑定文档与磁盘不一致或无法读取时，也会保守阻止查询；保存或关闭该文档后可重试，不同项目的语言服务仍相互隔离。未绑定的编辑器及尚未传到 worker 的编辑不在检查范围内。服务故障不应改变宿主文件。预览与打开仅接受当前结果且检查本地普通文件及工作区真实路径；虚拟 URI、外部文件或过期结果会被拒绝。历史使用单独授权的已记录位置。路径检查与实际打开之间仍有竞争窗口，不是防恶意并发替换的原子沙箱。服务自身可能读取工作区及项目数据；不要分享含路径或敏感内容的诊断信息。

## 开发与测试

```sh
npm test
npm run typecheck
npm run build
orca plugin test . --json
orca plugin inspect . --json
```

`npm test` 默认运行 Node 测试与 Orca 模拟宿主测试；真实服务测试默认明确跳过，不安装系统工具。`tests/fixtures/real-go` 与 `tests/fixtures/real-csharp` 是独立跨文件示例，包含接口、实现、引用和 Unicode；测试复制到临时目录并通过 LSP 发送未保存变更。若已自行安装相应 SDK 和服务、信任其可执行代码并接受服务可能运行项目工具及写入缓存，可显式运行：

```sh
# POSIX shell；Windows PowerShell 用 $env:ORCA_REAL_LSP_TEST='1'
ORCA_REAL_LSP_TEST=1 npm test -- real-lsp
```

可用环境变量 `GOPLS_PATH` / `CSHARP_LS_PATH` 指定测试服务路径；Go / dotnet 仍需在 PATH。未显式设置服务路径且缺少服务、或缺少 Go / dotnet 可执行文件时各测试说明跳过；显式设置的服务路径无效（包括空值）则失败。测试不检查实际安装的 .NET SDK 版本，工具存在但启动或项目加载失败则测试失败。示例没有外部包，C# 示例清空 NuGet 源，但语言服务/SDK 的运行和缓存行为不由测试完全控制。测试验证 LSP 响应，不验证 Orca UI、宿主保存冲突或实际 CLI 打开。

真实服务测试的超时不是硬隔离：启动或通知可能卡住，Node 测试超时不能保证取消操作或终止子进程。清理会尽力等待服务退出并重试临时目录删除；异常情况下可能仍需用户检查并终止残留服务、清理系统临时目录下的 `orca-real-lsp-*`。

许可证见 [LICENSE](LICENSE)；构建时第三方许可汇总在 `dist/THIRD-PARTY-NOTICES.txt`。
