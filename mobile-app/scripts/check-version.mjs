import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const packageVersion = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version
const gradle = readFileSync(join(appRoot, 'android/app/build.gradle'), 'utf8')
const versionName = gradle.match(/versionName\s+"([^"]+)"/)?.[1]
const versionCode = gradle.match(/versionCode\s+(\d+)/)?.[1]
const cargo = readFileSync(join(appRoot, 'src-tauri/Cargo.toml'), 'utf8')
const cargoVersion = cargo.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1]

const errors = []
if (!packageVersion) errors.push('package.json 缺少 version')
if (versionName !== packageVersion) errors.push(`build.gradle versionName 是 ${versionName ?? '缺失'}，package.json 是 ${packageVersion}`)
if (cargoVersion !== packageVersion) errors.push(`Cargo.toml version 是 ${cargoVersion ?? '缺失'}，package.json 是 ${packageVersion}`)
if (!versionCode) errors.push('build.gradle 缺少 versionCode')

if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exit(1)
}

console.log(`version ${packageVersion} (Android versionCode ${versionCode})`)
