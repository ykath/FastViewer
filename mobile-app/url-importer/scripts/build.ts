import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const output = resolve(import.meta.dir, '../../src-tauri/binaries/lightpage-url-importer-x86_64-pc-windows-msvc.exe')
await mkdir(dirname(output), { recursive: true })

const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, '../src/index.ts')],
  compile: {
    target: 'bun-windows-x64-baseline',
    outfile: output,
    windows: {
      hideConsole: true,
      title: 'LightPage URL Importer',
      publisher: 'FastViewer',
      version: '1.6.0.0',
      description: 'Local webpage to Markdown converter for LightPage',
    },
  },
  minify: true,
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`URL importer built: ${output}`)
