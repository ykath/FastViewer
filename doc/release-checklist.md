# 轻页 v1.1.1 发布检查清单

## Windows x64 Gate

- `npm run lint`
- `npm run desktop:test`
- `npm run desktop:build`
- 确认 `mobile-app/release/windows/LightPage.exe` 与 `LightPage_1.1.1_x64-setup.exe` 均生成。
- 在 Windows 10/11 验证安装、卸载、冷启动双击 Markdown、运行中再次双击、中文/空格文件名、应用内 HTML、搜索、目录、主题、阅读进度和导出。
- 首版产物未签名，发布说明必须提示 SmartScreen；不得提交证书、私钥或密码。

## 自动化 Gate

- `npm run lint`
- `npm run test`（编码、存储迁移、HTML 安全、资源路径、性能日志）
- `npm run test:e2e`（移动端 Chromium 核心流程）
- `npm run build && npm run check:bundle`
- `npx cap sync android`
- `gradlew :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease :app:lintDebug`

以上命令已接入 `.github/workflows/quality-gate.yml`。Release 默认启用 R8 与资源压缩；无签名变量时生成 unsigned APK。

## Release 签名变量

- `FASTVIEWER_KEYSTORE_PATH`
- `FASTVIEWER_KEYSTORE_PASSWORD`
- `FASTVIEWER_KEY_ALIAS`
- `FASTVIEWER_KEY_PASSWORD`

密钥和密码不得提交到仓库。

## 真机回归矩阵

发布前分别在 Android 8/10/12/14 或可获得的相邻版本执行：

1. 从系统文件管理器选择 Markdown、HTML、ZIP、RAR。
2. 从聊天、邮件、网盘通过 VIEW/SEND Intent 打开。
3. 验证 UTF-8、GBK、GB18030、UTF-16 文件与编码切换。
4. 验证 1/5/10 MB 文件的首屏、搜索、滚动和大文件源码兜底。
5. 验证恶意 HTML 默认不执行脚本、跳转、表单或弹窗；外部资源需明确授权。
6. 验证 ZIP/RAR 损坏、加密、路径穿越、深层目录与超限语料会中止并清理。
7. 验证 PDF、原文件、可见区域图片、全文图片和分页图片可跨 App 分享。
8. 删除记录后检查正文、原始文件、解压目录和目录授权缓存均已清理。

每台设备记录 Android 版本、内存档位、分辨率、通过项、失败日志和耗时指标；无 P0/P1 未解决问题后方可签名发布。
