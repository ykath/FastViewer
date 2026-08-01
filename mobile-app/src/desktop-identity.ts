export function desktopDocumentId(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase()
  let hash = 2166136261
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `desktop-${(hash >>> 0).toString(16).padStart(8, '0')}-${normalized.length}`
}
