export type MarkdownFrontmatter = {
  body: string
  metadata: Record<string, unknown>
  raw?: string
}

export function splitMarkdownFrontmatter(content: string): MarkdownFrontmatter {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(content)
  if (!opening) return { body: content, metadata: {} }

  const remainder = content.slice(opening[0].length)
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(remainder)
  if (!closing) return { body: content, metadata: {} }

  const raw = remainder.slice(0, closing.index)
  if (!/^[-\w.]+\s*:/m.test(raw)) return { body: content, metadata: {} }

  const metadata: Record<string, unknown> = {}
  for (const line of raw.split(/\r?\n/)) {
    const field = /^([-\w.]+)\s*:\s*(.*)$/.exec(line)
    if (!field) continue
    const [, key, encoded] = field
    try {
      metadata[key] = JSON.parse(encoded)
    } catch {
      metadata[key] = encoded
    }
  }

  const bodyStart = opening[0].length + closing.index + closing[0].length
  return { body: content.slice(bodyStart), metadata, raw }
}
