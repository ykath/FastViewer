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

for (const megabytes of [1, 5, 10]) {
  const bytes = megabytes * 1024 * 1024
  await writeFile(join(outputDirectory, `benchmark-${megabytes}mb.md`), fillToBytes(markdownSeed, bytes))
  await writeFile(join(outputDirectory, `benchmark-${megabytes}mb.html`), `<!doctype html><html><body>${fillToBytes(htmlSeed, bytes)}</body></html>`)
}

console.log(`已生成 1/5/10 MB Markdown 与 HTML 基准语料：${outputDirectory}`)
