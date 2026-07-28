# 轻页（LightPage）

轻页是一款本地优先的 Markdown / HTML 阅读器。前端使用 React、TypeScript 与 Vite；Android 使用 Capacitor，Windows 使用 Tauri 2。

## Windows x64 构建

Windows 10/11 构建需要 Node.js、Rust stable、`x86_64-pc-windows-msvc` target、Microsoft Visual C++ x64 Build Tools 和 WebView2。

在仓库根目录运行：

```bat
build-windows.bat
```

脚本会安装锁定依赖、执行前端与 Rust 测试、构建未签名的 x64 EXE 和 NSIS 安装包，并输出到：

- `mobile-app/release/windows/LightPage.exe`
- `mobile-app/release/windows/LightPage_1.1.2_x64-setup.exe`

未签名安装包可能触发 Windows SmartScreen。独立 EXE 依赖目标机器已有 WebView2；NSIS 安装包会在缺失时下载 WebView2 bootstrapper。后续签名配置应放入未跟踪的 `src-tauri/tauri.signing.conf.json`，不得提交证书或密码。

常用开发命令：

```bash
npm run desktop:dev
npm run desktop:test
npm run desktop:build
```

Windows 安装包注册 `.md`、`.markdown` 和 `.mdown` 文件关联。HTML 文件可从应用内打开；ZIP/RAR 原生导入仍仅支持 Android。

## Vite 模板说明

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
