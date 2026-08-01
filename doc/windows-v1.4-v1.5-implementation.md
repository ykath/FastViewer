# 轻页 Windows v1.4.0 / v1.5.0 实施说明

## v1.4.0（P0）

- 桌面文件使用规范化路径稳定 ID，正文保持路径引用，IndexedDB v4 只保存元数据、阅读状态和批注。
- 阅读页左侧支持在章节和当前文件所在目录之间切换，只枚举同级 Markdown/HTML 文档。
- 当前目录可以固定到最左侧导航栏，通过目录图标快速浏览；悬停显示完整路径并可随时取消收藏。
- 兼容 Rust `canonicalize` 返回的 `\\?\C:\...` 与 `\\?\UNC\...` 路径；首页显示文件所在目录，并可在 Windows 资源管理器中直接定位文件。
- 拖放路径在 Rust 层规范化和去重，前端只注册一个原生监听；单文件模式只打开首个有效文件。
- `notify` 监听当前文档及相对资源，前端 200 ms 防抖刷新。
- `Ctrl+Shift+P` 命令面板覆盖打开、搜索、目录、收藏、主题、字号、导出和关闭。
- 1 MB 以上 Markdown 使用安全边界扫描和 Worker 分块解析，未变化章节通过结构键与 revision 复用。

## v1.5.0（P1）

- Windows 桌面保持单活动文档，不显示顶部标签，也不恢复后台标签或并排窗格。
- Tauri 窗口状态插件保存窗口位置、大小和最大化状态。
- HTML 可注册/撤销当前用户级“打开方式”，不修改 Windows 受保护的默认应用选择。
- 可选写入 Windows 最近文档；单实例文件唤起继续进入有序队列。
- 图片/PDF 导出纳入可取消后台任务；Mermaid 观察实际图表容器，并在 WebView2 漏报可见事件时自动兜底绘制。
- Windows 下双击 Mermaid 可进入全屏大图查看器，支持 50%–500% 缩放、滚轮缩放、拖拽平移、适应窗口和 Esc 关闭。
- Markdown 分块按完整 AST 节点或围栏外安全边界切分，所有块重新拼接必须与原文逐字节一致。

## 本地验证

```powershell
cd mobile-app
npm run lint
npm run test
npm run build
npm run test:e2e
npm run desktop:test
```

Windows 安装包继续只构建 x64；产物版本从 `package.json` 自动读取。代码签名仍是独立发布工程事项。
