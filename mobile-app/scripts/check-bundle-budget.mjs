import { readFile, readdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const assetsDirectory = join(process.cwd(), 'dist', 'assets')
const files = await readdir(assetsDirectory)
const mainFile = files.find((file) => /^index-.*\.js$/.test(file))
if (!mainFile) throw new Error('未找到主入口 JavaScript 文件')

const content = await readFile(join(assetsDirectory, mainFile))
const gzipBytes = gzipSync(content).byteLength
const rawLimit = 450 * 1024
const gzipLimit = 150 * 1024
console.log(`主入口 ${mainFile}: ${(content.byteLength / 1024).toFixed(1)} KB，gzip ${(gzipBytes / 1024).toFixed(1)} KB`)
if (content.byteLength >= rawLimit || gzipBytes >= gzipLimit) {
  throw new Error('主入口包体超过发布门槛（450 KB / gzip 150 KB）')
}
