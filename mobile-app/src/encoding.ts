export type EncodingLabel = 'utf-8' | 'gbk' | 'utf-16le' | 'utf-16be' | 'latin1'

export type EncodingResult = {
  encoding: EncodingLabel
  content: string
  confidence: 'high' | 'medium' | 'low'
  hasBom: boolean
}

export const ENCODING_OPTIONS: { label: string; value: EncodingLabel }[] = [
  { label: 'UTF-8', value: 'utf-8' },
  { label: 'GBK / GB2312', value: 'gbk' },
  { label: 'UTF-16 LE', value: 'utf-16le' },
  { label: 'UTF-16 BE', value: 'utf-16be' },
  { label: 'Latin-1', value: 'latin1' },
]

export function detectAndDecode(bytes: Uint8Array): EncodingResult {
  const bom = detectBom(bytes)
  if (bom) {
    const stripped = bytes.subarray(bom.bomLength)
    return {
      encoding: bom.encoding,
      content: decodeWithEncoding(stripped, bom.encoding),
      confidence: 'high',
      hasBom: true,
    }
  }

  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024))
  if (isValidUtf8Sample(sample, sample.length < bytes.length)) {
    return {
      encoding: 'utf-8',
      content: decodeWithEncoding(bytes, 'utf-8'),
      confidence: 'high',
      hasBom: false,
    }
  }

  // UTF-8 invalid — try GBK
  try {
    const sampledText = decodeWithEncoding(sample, 'gbk')
    const hasCommonChinese = /[\u4e00-\u9fff]/.test(sampledText)
    const replacementCount = (sampledText.match(/\ufffd/g) || []).length
    const ratio = replacementCount / sampledText.length

    if (hasCommonChinese && ratio < 0.05) {
      return {
        encoding: 'gbk',
        content: decodeWithEncoding(bytes, 'gbk'),
        confidence: hasCommonChinese && ratio < 0.01 ? 'high' : 'medium',
        hasBom: false,
      }
    }
  } catch {
    // GBK decoder not available or failed
  }

  return {
    encoding: 'latin1',
    content: decodeWithEncoding(bytes, 'latin1'),
    confidence: 'low',
    hasBom: false,
  }
}

export function decodeWithEncoding(bytes: Uint8Array, encoding: EncodingLabel): string {
  const decoderLabel = encoding === 'latin1' ? 'iso-8859-1' : encoding
  const decoder = new TextDecoder(decoderLabel, { fatal: false })
  if (bytes.length <= 256 * 1024) return decoder.decode(bytes)
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
    chunks.push(decoder.decode(bytes.subarray(offset, offset + 256 * 1024), { stream: offset + 256 * 1024 < bytes.length }))
  }
  chunks.push(decoder.decode())
  return chunks.join('')
}

export function base64ToBytes(base64: string): Uint8Array {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

function detectBom(bytes: Uint8Array): { encoding: EncodingLabel; bomLength: number } | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', bomLength: 3 }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', bomLength: 2 }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', bomLength: 2 }
  }
  return null
}

function isValidUtf8Sample(bytes: Uint8Array, hasMore: boolean): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: hasMore })
    return true
  } catch {
    return false
  }
}
