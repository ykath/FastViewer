import { describe, expect, it } from 'vitest'
import {
  extractBilibiliId,
  extractLocalMarkdownMediaSources,
  extractYouTubeId,
  isVideoPath,
  parseVideoHtmlBlock,
} from './markdown-media'

describe('markdown-media', () => {
  it('识别常见视频扩展名', () => {
    expect(isVideoPath('./demo.mp4')).toBe(true)
    expect(isVideoPath('https://cdn.example.com/a.webm?x=1')).toBe(true)
    expect(isVideoPath('./cover.png')).toBe(false)
  })

  it('从 HTML video 标签提取 source', () => {
    const payload = parseVideoHtmlBlock(`<video width="320" height="240" controls>
  <source src="./LightPage-v1.5.2-promo.mp4" type="video/mp4">
</video>`)
    expect(payload?.sources).toEqual([{ src: './LightPage-v1.5.2-promo.mp4', type: 'video/mp4' }])
    expect(payload?.width).toBe('320')
    expect(payload?.controls).toBe(true)
  })

  it('提取本地视频引用路径', () => {
    const content = [
      '![宣传片](./promo.mp4)',
      '![[clip.webm|说明]]',
      '@[video](./local.mov)',
      '<video controls><source src="./nested/a.mp4"></video>',
      '[观看](./LightPage-v1.5.2-promo.mp4)',
    ].join('\n')
    expect(extractLocalMarkdownMediaSources(content)).toEqual([
      './promo.mp4',
      './local.mov',
      './LightPage-v1.5.2-promo.mp4',
      'clip.webm',
      './nested/a.mp4',
    ])
  })

  it('解析 YouTube 与 Bilibili 标识', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(extractBilibiliId('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('BV1xx411c7mD')
  })
})
