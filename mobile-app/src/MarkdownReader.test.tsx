// @vitest-environment jsdom
import { createRef } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MarkdownReader from './MarkdownReader'
import { extractMarkdownHeadings } from './html-processing'

const mermaidInitializeMock = vi.fn()
const mermaidRenderMock = vi.fn()

vi.mock('mermaid', () => ({
  default: {
    initialize: mermaidInitializeMock,
    render: mermaidRenderMock,
  },
}))

afterEach(() => cleanup())

beforeEach(() => {
  mermaidInitializeMock.mockClear()
  mermaidRenderMock.mockReset()
  mermaidRenderMock.mockImplementation(async (id: string) => ({
    svg: `<svg data-diagram-id="${id}"><text>开始</text></svg>`,
  }))
})

describe('MarkdownReader', () => {
  it('行内代码等嵌套格式生成与目录一致的标题锚点', () => {
    const content = '## 2.1 CLI 命令行接口 (`cli.py`) 与 **配置**'
    const [heading] = extractMarkdownHeadings(content)
    const { container } = render(
      <MarkdownReader
        content={content}
        contentRef={createRef<HTMLElement>()}
        themeMode="light"
      />,
    )

    expect(container.querySelector('h2')?.id).toBe(heading.id)
    expect(container.querySelector('h2')?.textContent).toBe('2.1 CLI 命令行接口 (cli.py) 与 配置')
  })

  it('绘制行内和块级公式，并把本地 KaTeX 样式包含在可导出内容中', () => {
    const contentRef = createRef<HTMLElement>()
    const { container } = render(
      <MarkdownReader
        content={'行内公式 $x^2$。\n\n$$\\text{CNR} = \\frac{HU_{\\text{target}} - HU_{\\text{background}}}{\\sigma_{\\text{background}}}$$'}
        contentRef={contentRef}
        themeMode="light"
      />,
    )

    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.querySelector('.katex-display')).not.toBeNull()
    expect(contentRef.current?.querySelector('style[data-search-exclude="true"]')).not.toBeNull()
  })

  it('公式语法错误不会让整篇 Markdown 渲染失败', () => {
    const { container } = render(
      <MarkdownReader
        content={'错误公式：$\\definitelyInvalid{x}$\n\n后续正文。'}
        contentRef={createRef<HTMLElement>()}
        themeMode="light"
      />,
    )

    expect(container.textContent).toContain('\\definitelyInvalid{x}')
    expect(screen.getByText('后续正文。')).toBeTruthy()
  })

  it('异步绘制多个 Mermaid 图表并使用唯一 ID 和严格安全配置', async () => {
    const { container } = render(
      <MarkdownReader
        content={'```mermaid\nflowchart TD\nA --> B\n```\n\n```mermaid\nflowchart LR\nC --> D\n```'}
        contentRef={createRef<HTMLElement>()}
        themeMode="light"
      />,
    )

    await waitFor(() => expect(container.querySelectorAll('.mermaid-svg svg')).toHaveLength(2))
    expect(mermaidRenderMock).toHaveBeenCalledTimes(2)
    expect(mermaidRenderMock.mock.calls[0][0]).not.toBe(mermaidRenderMock.mock.calls[1][0])
    expect(mermaidInitializeMock).toHaveBeenCalledWith(expect.objectContaining({
      securityLevel: 'strict',
      startOnLoad: false,
      theme: 'neutral',
    }))
  })

  it('主题切换时重新绘制 Mermaid 图表', async () => {
    const props = {
      content: '```mermaid\nflowchart TD\nA --> B\n```',
      contentRef: createRef<HTMLElement>(),
    }
    const { rerender } = render(<MarkdownReader {...props} themeMode="light" />)
    await waitFor(() => expect(mermaidRenderMock).toHaveBeenCalledTimes(1))

    rerender(<MarkdownReader {...props} themeMode="dark" />)

    await waitFor(() => expect(mermaidRenderMock).toHaveBeenCalledTimes(2))
    expect(mermaidInitializeMock).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }))
  })

  it('父组件发生无关重渲染时保持 Mermaid SVG 实例稳定', async () => {
    const contentRef = createRef<HTMLElement>()
    const onOpenExternalLink = vi.fn()
    const props = {
      content: '```mermaid\nflowchart TD\nA --> B\n```',
      contentRef,
      themeMode: 'light' as const,
      onOpenExternalLink,
    }
    const { container, rerender } = render(<MarkdownReader {...props} />)
    await waitFor(() => expect(container.querySelector('.mermaid-svg svg')).not.toBeNull())
    const firstSvg = container.querySelector('.mermaid-svg svg')

    rerender(<MarkdownReader {...props} />)

    expect(mermaidRenderMock).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.mermaid-svg svg')).toBe(firstSvg)
  })

  it('Mermaid 语法错误只在图表位置显示源码回退', async () => {
    mermaidRenderMock.mockRejectedValueOnce(new Error('Parse error'))
    render(
      <MarkdownReader
        content={'正文仍然显示。\n\n```mermaid\nnot a diagram\n```'}
        contentRef={createRef<HTMLElement>()}
        themeMode="light"
      />,
    )

    expect(screen.getByText('正文仍然显示。')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('流程图绘制失败'))
    expect(screen.getByRole('alert').textContent).toContain('not a diagram')
  })
})
