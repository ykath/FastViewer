import { describe, expect, it } from 'vitest'
import { scanSearchText } from './library-search-scan'

describe('全文检索扫描', () => {
  it('返回标题、片段和命中次数', () => {
    const hits = scanSearchText('口令', [{
      documentId: 'doc-1',
      fileName: '笔记.md',
      text: '# 第一章\n\n这里有口令，后面还有口令。',
    }])
    expect(hits).toEqual([{
      documentId: 'doc-1',
      fileName: '笔记.md',
      heading: '第一章',
      snippet: expect.stringContaining('口令'),
      hitCount: 2,
    }])
  })

  it('1000 篇文档查询 P95 不超过 150ms', () => {
    const documents = Array.from({ length: 1000 }, (_, index) => ({
      documentId: `doc-${index}`,
      fileName: `文档-${index}.md`,
      text: `# 章节 ${index}\n${'正文段落 '.repeat(180)}${index % 50 === 0 ? '检索口令甲' : '其他内容'}`,
    }))
    const samples: number[] = []
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now()
      const hits = scanSearchText('检索口令甲', documents)
      samples.push(performance.now() - started)
      expect(hits).toHaveLength(20)
    }
    samples.sort((left, right) => left - right)
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]
    expect(p95).toBeLessThanOrEqual(150)
  })
})
