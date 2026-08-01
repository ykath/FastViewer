# 轻页（LightPage）

轻页是一款本地优先的 Markdown / HTML 阅读器，面向 Android 与 Windows。它适合快速打开来自聊天、邮件、文件管理器或本地目录的文档，在不上传正文的前提下完成阅读、搜索、批注、收藏和导出。

![轻页界面](mobile-app/src/assets/hero.png)

## 当前版本状态

轻页目前按平台分别演进，两个平台的应用版本号并不相同：

| 平台 | 当前源码版本 | 最新公开 Release | 说明 |
| --- | --- | --- | --- |
| Windows x64 | **1.5.0** | **v1.5.0** | 当前主发布版本，提供安装版和便携版 |
| Android | **1.3.0**（`versionCode 6`） | v1.1.2 | v1.3.0 功能已进入源码，但尚未发布对应 APK |

> GitHub 的 `v1.5.0` 是 Windows 发布版本，不包含 Android 1.5.0。Android 原生工程仍为 1.3.0，项目不会用错误版本号包装 Android 安装包。

## 下载

请从项目的 [GitHub Releases](https://github.com/ykath/FastViewer/releases) 下载，避免使用来源不明的安装文件。

### Windows 1.5.0

[前往最新 Release](https://github.com/ykath/FastViewer/releases/latest)：

- 安装版：`LightPage_1.5.0_windows-x64-setup.exe`
- 便携版：`LightPage_1.5.0_windows-x64.exe`

推荐普通用户使用安装版。便携版依赖目标电脑已安装 Microsoft Edge WebView2 Runtime。

### Android

Android 当前源码版本为 1.3.0，但暂未提供对应的 GitHub Release APK。如需直接安装，当前公开可下载的是 [v1.1.2 调试签名 APK](https://github.com/ykath/FastViewer/releases/tag/v1.1.2)：

- `LightPage_1.1.2_android-debug.apk`

如需体验 Android 1.3.0 的最新功能，请按下方开发说明从当前源码构建。

> Android APK 使用调试证书签名，Windows 文件尚未进行代码签名。Android 调试签名版本可能无法覆盖其他证书签名的旧版本；Windows SmartScreen 也可能显示安全提示。

## 核心功能

### 跨平台阅读能力

- 打开并阅读 Markdown、HTML 文档，渲染失败时可切换到源码或纯文本兜底视图。
- 支持 GFM 表格、任务列表、删除线、自动链接、代码高亮、KaTeX 数学公式和 Mermaid 图表。
- 根据 Markdown 标题或 HTML 标题自动生成目录，支持章节跳转和当前位置跟随。
- 支持文内搜索、结果高亮、上一处/下一处跳转。
- 提供浅色、深色和跟随系统主题，以及正文字号、代码字号、行高、内容宽度等排版设置。
- 保存最近阅读、收藏、文件库和每份文档的阅读位置。
- 支持复制全文，以及图片、分页长图、PDF 和原始文件导出；Android 还可导出批注摘要。
- HTML 默认在安全沙箱内渲染，危险脚本、自动跳转、自动下载和远程资源受到限制。
- 文档正文、搜索词和批注默认只在本机处理，不自动上传到服务器。

### Android 1.3.0

- 支持从其他应用通过 `VIEW`、`SEND`、`SEND_MULTIPLE` 打开文件；请求先复制到应用私有目录，再通过持久化队列按顺序处理，可确认、重试、丢弃并在进程重启后恢复。
- 支持 ZIP / RAR 文档包持久化、SHA-256 去重、条目按需加载、包内目录、上一篇/下一篇和阅读位置恢复；优先打开 README 或 index 文档。
- 支持 Markdown 文本高亮、短批注和书签，可编辑、删除、跳转，并在正文轻微变化后尝试重新定位；无法可靠定位的项目会标记为待重新关联。
- 支持将批注导出为 Markdown 摘要。
- 大文档使用 Worker 生成分块渲染计划，按视口渐进挂载；搜索、目录和批注跳转会主动加载目标块。
- 支持简洁、深色、强调三套分享卡片模板，长内容自动分页，可删除单页并为有效 HTTP/HTTPS 来源生成二维码后调用系统分享。
- 支持点击进入沉浸阅读、右侧边缘呼出目录、双击恢复排版，以及默认关闭的音量键翻页。
- 针对 600 dp / 840 dp 宽度提供平板、横屏和折叠屏布局，并避让折叠铰链区域。
- 提供缓存占用统计与清理入口；解压缓存按 LRU 回收，分享缓存、外部打开队列和低存储场景设有容量保护。

### Windows 1.5.0

- 保持单活动文档阅读模式；左侧阅读栏可在“章节”和“当前目录”之间切换，快速打开同目录的 Markdown / HTML 文档。
- 可将当前目录固定到最左侧导航栏，悬停查看完整路径，并随时取消固定。
- 首页显示文件所在目录，可直接在 Windows 资源管理器中定位文件。
- 支持文件选择、拖放、文件关联和单实例唤起；路径在 Rust 层规范化、去重，并兼容本地路径与 UNC 路径。
- 监听当前文档及其相对资源的外部修改，防抖后自动刷新阅读内容。
- 使用 `Ctrl+Shift+P` 打开命令面板，可执行打开、搜索、目录、收藏、主题、字号、导出和关闭等操作。
- 自动保存窗口位置、大小和最大化状态。
- 可在设置中注册或撤销当前用户级 HTML“打开方式”，并可选择将成功打开的文件写入 Windows 最近文档。
- 1 MB 以上 Markdown 使用安全边界扫描、Worker 分块解析和未变化章节复用，降低大文档更新时的重复渲染。
- 图片和 PDF 导出作为可取消后台任务执行；Mermaid 在 WebView2 可见性事件漏报时会自动兜底绘制。
- 双击 Mermaid 图表可打开全屏查看器，支持 50%–500% 缩放、滚轮缩放、拖拽平移、适应窗口、复制 PNG 图像和 `Esc` 关闭。

## 平台差异与已知限制

| 能力 | Android 1.3.0 | Windows 1.5.0 |
| --- | --- | --- |
| 从其他应用/资源管理器打开 | 支持 Android Intent 与系统分享入口 | 支持文件选择、拖放、文件关联和单实例唤起 |
| ZIP / RAR 文档包 | 支持 | 暂不支持原生导入 |
| 批注、书签、批注摘要 | 支持 | 数据底座兼容，当前重点仍是单文件阅读 |
| 分享卡片、系统分享 | 支持 | 以图片、PDF 和原文件导出为主 |
| 同目录文档切换、固定目录 | 不适用 | 支持 |
| Mermaid 全屏缩放查看 | 常规自适应显示 | 支持双击全屏查看 |
| 发布架构 | Android APK | 仅 Windows x64 |

其他限制：

- Windows 当前不提供多标签、后台标签恢复或并排阅读。
- Windows 只枚举和打开受支持的 Markdown / HTML 文档；目录收藏不是完整的文件管理器或在线工作区。
- Android 的 RAR 解压依赖当前原生库，不支持 RAR5 或加密压缩包；这类文件请转换为 ZIP 或 RAR4。
- HTML 默认采用最小权限沙箱策略；被拦截的脚本或远程资源需要用户明确授权，不能假定任意网页应用都能完整运行。
- 当前安装包未正式签名，生产分发前仍需配置 Android 正式签名和 Windows 代码签名。

## 版本变化

### v1.5.0（2026-08-01，Windows 当前公开版本）

- 明确 Windows 继续采用单活动文档模式，不显示顶部标签，也不恢复后台标签或并排窗格。
- 保存窗口位置、尺寸和最大化状态，改善桌面端再次启动体验。
- 增加当前用户级 HTML“打开方式”的注册与撤销，并加入可选的 Windows 最近文档集成。
- 完善单实例文件唤起队列，确保外部连续打开按顺序进入应用。
- 将图片/PDF 导出纳入可取消的后台任务，降低重型导出对阅读界面的阻塞。
- 改进 Mermaid 懒加载与 WebView2 兜底绘制；新增双击全屏查看、50%–500% 缩放、拖拽平移和适应窗口。
- 强化 Markdown 分块边界，保证分块重新拼接后与原文逐字节一致。
- 修复发布 Gate：兼容 npm 10 锁文件、Linux 测试排除规则、CI 性能计时抖动和 Gradle Wrapper 路径，双平台质量检查全部通过。

### v1.4.0（2026-08-01，Windows 内部里程碑）

> 此版本是进入 v1.5.0 的开发里程碑，没有单独创建 GitHub Release。

- 桌面文件改用规范化路径生成稳定 ID，数据库只保存元数据、阅读状态和批注，正文继续引用本地路径。
- 阅读栏新增“章节 / 当前目录”双视图，并支持固定常用目录。
- 首页增加文件所在目录展示和资源管理器定位入口。
- 统一拖放路径规范化与去重；单文件模式仅打开第一个有效文档。
- 监听当前文件及相对资源变化，并以 200 ms 防抖刷新。
- 新增 `Ctrl+Shift+P` 命令面板和完整桌面快捷操作入口。
- 为 1 MB 以上 Markdown 增加安全边界扫描、Worker 分块解析和未变化章节复用。

### v1.3.0（2026-08-01，Android 当前源码版本）

> Android 原生工程版本为 1.3.0，但目前没有对应的公开 GitHub Release APK。

- 新增三套移动分享卡片模板、长文自动分页、页面删除、来源二维码和系统分享。
- 新增点击沉浸、右侧边缘目录、双击恢复排版和可选音量键翻页。
- 完成平板、横屏和折叠屏响应式适配，支持折叠铰链安全分栏。
- 完善流式 I/O 与缓存配额：解压缓存 LRU、分享缓存 100 MB / 24 小时、外部队列 300 MB，并在剩余空间低于 500 MB 时阻止大型解压。
- 增加缓存占用统计、主动清理和低存储降级入口。

### v1.2.0（2026-08-01，Android 内部里程碑）

> 此版本是 Android P0 功能里程碑，没有单独创建 GitHub Release。

- 数据仓储升级为 IndexedDB v3，将元数据、正文 Blob、阅读状态、批注、文档包和迁移状态分仓保存；启动时只加载元数据，正文按需读取。
- 建立多会话领域模型，Android 界面仍保持单活动阅读会话。
- 重构 Android 外部打开队列，覆盖冷启动、前台、后台和多文件分享，并支持持久化恢复、重试、丢弃与容量限制。
- 将 ZIP / RAR 导入升级为连续阅读文档包，支持原包持久化、SHA-256 去重、包内目录、上一篇/下一篇和安全删除。
- 新增 Markdown 高亮、批注、书签、重定位、失效标记、跳转和摘要导出。
- 引入基于 AST 顶层节点和 Worker RenderPlan 的渐进渲染，兼顾目录、搜索、批注锚点及 Mermaid 稳定性。

### v1.1.2（2026-07-28，Android / Windows 公开版本）

- 修复超宽 Mermaid 横向流程图超出正文并产生整页水平滚动条的问题。
- Mermaid SVG 改为自适应正文宽度，并增加单元测试和端到端回归测试。
- 修复 npm 锁文件内部依赖版本不一致导致 Windows 构建时 `npm ci` 失败的问题。
- 完成 Android APK、Windows x64 便携版和 NSIS 安装包构建验证。

### v1.1.1（2026-07-24，Android / Windows 公开版本）

- 强化 Windows 双击文件的启动队列时序、串行消费和瞬时读取重试，避免文档库恢复覆盖新打开文件。
- 修复 Android 脚本隔离 HTML 无法动态测量时的底部大块留白，使内容区铺满至底部导航。
- 为 Windows Mermaid 缩放查看器增加按钮及 `Ctrl+C` 复制 PNG 图像能力。
- 优化顶部工具栏背景透明度。
- 修复 Windows 下 Markdown 同目录图片不能正确显示的问题。

### v1.1.0（2026-07-22，首个公开 Release）

- 建立 Android 与 Windows 双平台公开发布基线。
- Windows 端引入 Tauri 2，并将桌面布局调整为左侧导航栏。
- 改进代码高亮、KaTeX 公式和 Mermaid 图表渲染。
- 修复 Markdown 章节提取：忽略围栏代码块和四空格缩进代码块中的伪标题，正确识别真实章节。
- 修复标题锚点生成与章节跳转，并增加对应回归测试。
- 补齐项目 README、下载说明、构建脚本和发布检查文档。

完整发布记录与校验值请查看 [GitHub Releases](https://github.com/ykath/FastViewer/releases)。更详细的实现说明见 [Android v1.2 / v1.3](doc/android-v1.2-v1.3-implementation.md) 和 [Windows v1.4 / v1.5](doc/windows-v1.4-v1.5-implementation.md)。

## 安装说明

### Android

下载 APK 后，在系统提示时允许当前应用安装未知来源应用。调试签名版本不能覆盖使用其他证书签名的旧版本；如遇签名冲突，请先备份应用数据，再卸载旧版本。

### Windows

- 支持 Windows 10 / 11 x64。
- 推荐安装 `windows-x64-setup.exe`；便携版需要系统已安装 WebView2 Runtime。
- 未签名构建可能触发 SmartScreen，运行前请核对下载来源和 Release 页面提供的 SHA-256。

## 本地开发

基础环境：Node.js、npm。Android 构建还需要 JDK 21 和 Android SDK；Windows 构建还需要 Rust stable、`x86_64-pc-windows-msvc` target、Microsoft Visual C++ x64 Build Tools 和 WebView2。

```bash
cd mobile-app
npm ci
npm run dev
```

常用质量检查：

```bash
cd mobile-app
npm run lint
npm run test
npm run build
npm run check:bundle
npm run test:e2e
npm run desktop:test
```

仓库根目录提供平台构建脚本：

```bat
build-apk.bat
build-windows.bat
```

- Android APK：`mobile-app/android/app/build/outputs/apk/`
- Windows 产物：`mobile-app/release/windows/`

## 技术栈

- React 19、TypeScript 6、Vite 8
- Capacitor 8（Android）
- Tauri 2、Rust（Windows）
- IndexedDB、Web Worker、Android 原生 Java
- Vitest、Testing Library、Playwright、Cargo Test

## 项目结构

```text
FastViewer/
├─ mobile-app/          前端、Android 与 Windows 应用源码
│  ├─ android/          Capacitor Android 原生工程
│  ├─ src-tauri/        Tauri / Rust Windows 工程
│  ├─ src/              跨平台 React 前端与领域层
│  └─ e2e/              Playwright 端到端测试
├─ doc/                 产品、帮助、隐私、实现与发布文档
├─ test/                测试资料
├─ build-apk.bat        Android 构建脚本
└─ build-windows.bat    Windows x64 构建脚本
```

更多说明请查看 [使用帮助](doc/user-help.md)、[隐私说明](doc/privacy.md) 和 [发布检查清单](doc/release-checklist.md)。

## 反馈

发现问题或希望增加功能，请通过 [GitHub Issues](https://github.com/ykath/FastViewer/issues) 提交反馈，并尽量附上系统版本、应用版本、文件类型和复现步骤。请勿上传包含隐私或机密内容的原始文档。
