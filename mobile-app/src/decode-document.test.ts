import { describe, expect, it } from 'vitest'
import { decodeDocumentBytes } from './decode-document'

describe('文档解码管线', () => {
  it('同时返回文本和可用于原文件分享的原始字节', async () => {
    const bytes = new TextEncoder().encode('# 轻页')
    const result = await decodeDocumentBytes(bytes)
    expect(result.content).toBe('# 轻页')
    expect(result.encoding).toBe('utf-8')
    expect(result.rawBase64).toBe('IyDovbvpobU=')
  })
})
