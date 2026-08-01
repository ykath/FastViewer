import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const outputDirectory = join(process.cwd(), 'benchmarks', 'generated')
await mkdir(outputDirectory, { recursive: true })

function fillToBytes(seed, targetBytes) {
  const chunks = []
  let size = 0
  while (size < targetBytes) {
    const chunk = seed.replaceAll('{{index}}', String(chunks.length + 1))
    chunks.push(chunk)
    size += Buffer.byteLength(chunk)
  }
  return chunks.join('').slice(0, targetBytes)
}

const markdownSeed = '# 性能基准 {{index}}\n\n正文包含中文、[链接](https://example.com)和 `code`。\n\n```js\nconsole.log({{index}})\n```\n\n'
const htmlSeed = '<section><h2>性能基准 {{index}}</h2><p>正文包含中文、<a href="https://example.com">链接</a>和代码。</p><pre>console.log({{index}})</pre></section>\n'

for (const megabytes of [1, 5, 10, 20]) {
  const bytes = megabytes * 1024 * 1024
  await writeFile(join(outputDirectory, `benchmark-${megabytes}mb.md`), fillToBytes(markdownSeed, bytes))
  await writeFile(join(outputDirectory, `benchmark-${megabytes}mb.html`), `<!doctype html><html><body>${fillToBytes(htmlSeed, bytes)}</body></html>`)
}

const workspaceRoot = join(outputDirectory, 'workspace-10000')
await mkdir(workspaceRoot, { recursive: true })
for (let index = 0; index < 10_000; index += 1) {
  const directory = join(workspaceRoot, `group-${String(Math.floor(index / 100)).padStart(3, '0')}`)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `document-${String(index).padStart(5, '0')}.md`), `# 基准文档 ${index}\n\n本地工作区关键字 benchmark-${index}.\n`)
}

console.log(`已生成 1/5/10/20 MB 文档与 10,000 文件工作区基准语料：${outputDirectory}`)
