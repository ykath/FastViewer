import { describe, expect, it } from 'vitest'
import { readSvgDimensions } from './mermaid-image'

describe('Mermaid 图像尺寸', () => {
  it('优先读取 viewBox，支持带偏移的流程图', () => {
    expect(readSvgDimensions('<svg viewBox="10 20 640 360"></svg>')).toEqual({ width: 640, height: 360 })
  })

  it('在没有 viewBox 时读取显式尺寸，并为异常 SVG 提供稳定尺寸', () => {
    expect(readSvgDimensions('<svg width="800" height="600"></svg>')).toEqual({ width: 800, height: 600 })
    expect(readSvgDimensions('<svg></svg>')).toEqual({ width: 1200, height: 900 })
  })
})
