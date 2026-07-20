import { describe, expect, it } from 'vitest'
import { base64ToBytes, detectAndDecode } from './encoding'

describe('文件编码', () => {
  it('识别并移除 UTF-8 BOM', () => {
    const result = detectAndDecode(new Uint8Array([0xef, 0xbb, 0xbf, 0xe4, 0xb8, 0xad]))
    expect(result).toMatchObject({ encoding: 'utf-8', content: '中', hasBom: true, confidence: 'high' })
  })

  it('拒绝 UTF-8 过长编码', () => {
    const result = detectAndDecode(new Uint8Array([0xc0, 0xaf]))
    expect(result.encoding).not.toBe('utf-8')
  })

  it('正确恢复 Base64 原始字节', () => {
    expect(Array.from(base64ToBytes('AAEC/v8='))).toEqual([0, 1, 2, 254, 255])
  })
})
