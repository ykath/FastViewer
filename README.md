# 轻页（LightPage）

轻页是一款本地优先的 Markdown / HTML 阅读器，面向 Android 与 Windows。它适合快速打开聊天、邮件、文件管理器或本地目录中的文档，在不上传正文的前提下完成阅读、搜索、收藏和导出。

![轻页界面](mobile-app/src/assets/hero.png)

## 下载

请前往 [GitHub Releases](https://github.com/ykath/FastViewer/releases/latest) 下载最新版本：

- Android：`LightPage_1.1.0_android-debug.apk`
- Windows 免安装版：`LightPage_1.1.0_windows-x64.exe`
- Windows 安装包：`LightPage_1.1.0_windows-x64-setup.exe`

> 当前 Android APK 使用调试证书签名，Windows 文件尚未进行代码签名。安装时系统可能显示安全提示，请只从本仓库的 Releases 页面下载。

## 功能特性

- 阅读 Markdown、HTML 与纯文本内容
- 支持 GFM 表格、任务列表、代码高亮、KaTeX 公式和 Mermaid 图表
- 自动生成文档目录，支持章节跳转与文内搜索
- 提供浅色、深色主题，以及字号、行高和内容宽度设置
- 保存最近阅读、收藏、文件库与阅读位置
- Android 支持从其他应用打开文件，并导入 ZIP / RAR 文档包
- 支持导出图片、分页长图、PDF 和原始文件
- HTML 默认在安全沙箱中渲染，脚本与远程资源默认受限
- 文档默认只在本机处理，不自动上传正文或搜索内容

## 安装说明

### Android

下载 APK 后，在系统提示时允许当前应用安装未知来源应用，然后完成安装。调试签名版本不能覆盖使用其他证书签名的旧版本；如遇签名冲突，请先备份数据并卸载旧版本。

### Windows

- 推荐普通用户下载 `windows-x64-setup.exe` 安装包。
- `windows-x64.exe` 是免安装主程序，目标电脑需要 WebView2 Runtime。
- 因当前构建未进行代码签名，Windows SmartScreen 可能要求确认后才能运行。

## 本地开发

环境要求：Node.js、npm；Android 构建还需要 JDK 21 与 Android SDK；Windows 构建还需要 Rust stable、MSVC x64 Build Tools 和 WebView2。

```bash
cd mobile-app
npm ci
npm run dev
```

常用检查：

```bash
cd mobile-app
npm run lint
npm run test
npm run build
```

仓库根目录提供了平台构建脚本：

```bat
build-apk.bat
build-windows.bat
```

Windows 构建产物会收集到 `mobile-app/release/windows/`；Android APK 位于 `mobile-app/android/app/build/outputs/apk/`。

## 技术栈

- React 19、TypeScript、Vite
- Capacitor 8（Android）
- Tauri 2、Rust（Windows）
- Vitest、Testing Library、Playwright

## 项目结构

```text
FastViewer/
├─ mobile-app/          前端、Android 与 Windows 应用源码
├─ doc/                 产品、帮助、隐私与发布文档
├─ build-apk.bat        Android 构建脚本
└─ build-windows.bat    Windows x64 构建脚本
```

更多说明请查看 [使用帮助](doc/user-help.md)、[隐私说明](doc/privacy.md) 和 [发布检查清单](doc/release-checklist.md)。

## 反馈

发现问题或希望增加功能，请通过 [GitHub Issues](https://github.com/ykath/FastViewer/issues) 提交反馈，并尽量附上系统版本、文件类型和复现步骤。请勿上传包含隐私或机密内容的原始文档。
