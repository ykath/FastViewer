import { describe, expect, test } from 'bun:test'
import { normalizeXMediaUrl, normalizeXText, renderXSnapshot, xTextToMarkdown } from './x-content'

describe('X content extraction', () => {
  test('preserves paragraphs and visible single line breaks', () => {
    const source = 'AI that finally hears you.\r\n\r\nPowered by Hy3\r\n→ precision ASR\r\n\r\nWins on:\r\n• general recognition\r\n• context awareness'

    expect(normalizeXText(source)).toBe('AI that finally hears you.\n\nPowered by Hy3\n→ precision ASR\n\nWins on:\n• general recognition\n• context awareness')
    expect(xTextToMarkdown(source)).toBe('AI that finally hears you.\n\nPowered by Hy3  \n→ precision ASR\n\nWins on:  \n• general recognition  \n• context awareness')
  })

  test('keeps only content media, deduplicates it and requests original X images', () => {
    const result = renderXSnapshot({
      title: 'Tencent Hy on X',
      canonicalUrl: 'https://x.com/TencentHunyuan/status/1',
      targetStatusId: '1',
      targetMatched: true,
      user: 'Tencent Hy @TencentHunyuan',
      publishedAt: '2026-08-04T09:58:55.000Z',
      text: 'First line\nSecond line',
      media: [
        { source: 'https://pbs.twimg.com/media/example?format=jpg&name=small', alt: 'ASR benchmark' },
        { source: 'https://pbs.twimg.com/media/example?format=jpg&name=small', alt: 'duplicate' },
        { source: 'https://pbs.twimg.com/media/example.png', alt: 'schema duplicate' },
        { source: 'https://pbs.twimg.com/profile_images/avatar.jpg', alt: 'avatar' },
      ],
    })

    expect(normalizeXMediaUrl('https://pbs.twimg.com/media/example?format=jpg&name=small')).toBe('https://pbs.twimg.com/media/example?format=jpg&name=orig')
    expect(result.markdown).toContain('First line  \nSecond line')
    expect(result.markdown).toContain('![ASR benchmark](<https://pbs.twimg.com/media/example?format=jpg&name=orig>)')
    expect(result.markdown.match(/pbs\.twimg\.com\/media/g)).toHaveLength(1)
    expect(result.markdown).not.toContain('profile_images')
    expect(result.warnings).toEqual([])
  })

  test('reports a missing requested status instead of silently selecting another tweet', () => {
    const result = renderXSnapshot({
      title: 'X',
      targetStatusId: '2084579829303615497',
      targetMatched: false,
      media: [],
    })

    expect(result.markdown).toBe('')
    expect(result.warnings).toEqual([
      '未在页面 DOM 中找到目标推文 2084579829303615497',
      '目标推文正文和媒体均未加载',
    ])
  })
})
