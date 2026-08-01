# 轻页 Android v1.2.0 / v1.3.0 实施说明

## 已落地范围

- IndexedDB v3：元数据、正文 Blob、阅读状态、批注、文档包与迁移状态分仓存储；启动仅加载元数据，正文按需读取。
- 多会话底座：Android 保持单活动阅读界面，领域层支持多个独立 `sessionId`，为 Windows 多标签预留。
- Android 外部打开队列：VIEW、SEND、SEND_MULTIPLE 先复制到私有目录，再按持久化队列串行处理；支持确认、重试、丢弃、容量限制和进程恢复。
- 文档包：ZIP/RAR 原包持久化、SHA-256 去重、条目懒加载、README/index 优先顺序、包内目录、上一篇/下一篇与安全删除。
- Markdown 批注：黄色高亮、批注、书签、编辑、删除、重定位、失效标记、跳转和 Markdown 摘要导出。
- 渐进渲染：AST 顶层节点分块、Worker 生成 RenderPlan、视口预加载、离屏占位、搜索/目录/批注强制挂载目标块，Mermaid 挂载后保持稳定。
- 分享卡片：简洁、深色、强调三套模板，长文分页、页面删除、有效 HTTP/HTTPS 来源二维码和系统分享。
- 阅读交互：点击沉浸、右侧边缘目录、双击恢复排版、可选音量键翻页及 Android 返回层级。
- 大屏适配：600/840 dp 响应式布局，AndroidX Window 折叠特征监听和铰链安全分栏。
- 缓存配额：可再生解压缓存 LRU、分享缓存 100 MB/24 小时、外部队列 300 MB、低于 500 MB 时阻止大型解压，并提供占用统计与清理入口。
- Windows 兼容：保留现有 Tauri 文件打开、相对资源、搜索、目录、主题和导出路径，共享 v3 仓储与 RenderPlan，不引入 Android 专属依赖到领域层。

## 版本

- Android v1.2.0：`versionCode 5`（P0 里程碑）
- Android v1.3.0：`versionCode 6`（当前代码版本）
- 前端与 Tauri 包版本：`1.3.0`

## 本地验证命令

```powershell
cd mobile-app
npm run lint
npm run test
npm run build
npm run check:bundle
npm run test:e2e
npm run desktop:test

cd android
.\gradlew.bat :app:compileDebugJavaWithJavac :app:testDebugUnitTest :app:assembleDebug
```

真机发布 Gate（Pixel 6a、API 24/29/35、折叠屏、30 次外部连续打开、低存储与进程终止恢复）仍需在发布流水线和设备实验室执行。
