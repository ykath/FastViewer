import type { Image, Link, Paragraph, Root, RootContent } from 'mdast'
import { visit } from 'unist-util-visit'
import {
  buildBilibiliEmbedUrl,
  buildYouTubeEmbedUrl,
  extractBilibiliId,
  extractYouTubeId,
  isVideoPath,
  parseVideoHtmlBlock,
  type MarkdownVideoPayload,
} from './markdown-media'

import type { MarkdownVideo } from './mdast-markdown-video'

export default function remarkVideo() {
  return (tree: Root) => {
    visit(tree, 'html', (node, index, parent) => {
      if (index === undefined || !parent) return
      const match = /<video\b[\s\S]*?<\/video>/i.exec(node.value)
      if (!match) return
      const payload = parseVideoHtmlBlock(match[0])
      if (!payload) return
      const remainder = node.value.slice(match.index! + match[0].length).trim()
      const replacement: Root['children'] = [createMarkdownVideoNode(payload)]
      if (remainder) {
        replacement.push({ type: 'paragraph', children: [{ type: 'text', value: remainder }] })
      }
      parent.children.splice(index, 1, ...replacement)
    })

    visit(tree, 'image', (node: Image, index, parent) => {
      if (index === undefined || !parent || !isVideoPath(node.url)) return
      parent.children[index] = createMarkdownVideoNode({
        variant: 'file',
        sources: [{ src: node.url }],
        controls: true,
        label: node.alt || undefined,
      })
    })

    visit(tree, 'paragraph', (node: Paragraph, index, parent) => {
      if (index === undefined || !parent) return
      const inlineHtml = matchInlineHtmlVideoParagraph(node)
      if (inlineHtml) {
        const raw = paragraphSourceText(node)
        const match = /<video\b[\s\S]*?<\/video>/i.exec(raw.trim())!
        const remainder = raw.slice(match.index! + match[0].length).trim()
        const replacement: Root['children'] = [createMarkdownVideoNode(inlineHtml)]
        if (remainder) {
          replacement.push({ type: 'paragraph', children: [{ type: 'text', value: remainder }] })
        }
        parent.children.splice(index, 1, ...replacement)
        return
      }
      const videoLink = matchVideoLinkParagraph(node)
      if (videoLink) {
        parent.children[index] = createMarkdownVideoNode(videoLink)
        return
      }
      const obsidian = matchObsidianVideoParagraph(node)
      if (obsidian) {
        parent.children[index] = createMarkdownVideoNode(obsidian)
        return
      }
      const directive = matchDirectiveParagraph(node)
      if (directive) {
        parent.children[index] = createMarkdownVideoNode(directive)
      }
    })
  }
}

function createMarkdownVideoNode(payload: MarkdownVideoPayload): RootContent {
  return { type: 'markdownVideo', payload }
}

function matchVideoLinkParagraph(node: Paragraph): MarkdownVideoPayload | null {
  const meaningful = node.children.filter((child) => !(child.type === 'text' && child.value.trim() === ''))
  if (meaningful.length !== 1 || meaningful[0].type !== 'link') return null
  const link = meaningful[0]
  if (!isVideoPath(link.url)) return null
  const label = link.children.map((child) => (child.type === 'text' ? child.value : '')).join('').trim()
  return {
    variant: 'file',
    sources: [{ src: link.url }],
    controls: true,
    label: label || undefined,
  }
}

function matchObsidianVideoParagraph(node: Paragraph): MarkdownVideoPayload | null {
  if (node.children.length !== 1 || node.children[0].type !== 'text') return null
  const match = /^!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(node.children[0].value.trim())
  if (!match || !isVideoPath(match[1])) return null
  return {
    variant: 'file',
    sources: [{ src: match[1].trim() }],
    controls: true,
    label: match[2]?.trim() || undefined,
  }
}

function paragraphSourceText(node: Paragraph) {
  return node.children
    .map((child) => (child.type === 'text' || child.type === 'html' ? child.value : ''))
    .join('')
}

function matchInlineHtmlVideoParagraph(node: Paragraph): MarkdownVideoPayload | null {
  const raw = paragraphSourceText(node).trim()
  const match = /<video\b[\s\S]*?<\/video>/i.exec(raw)
  if (!match) return null
  return parseVideoHtmlBlock(match[0])
}

function matchDirectiveParagraph(node: Paragraph): MarkdownVideoPayload | null {
  const links = node.children.filter((child): child is Link => child.type === 'link')
  const hasDirectivePrefix = node.children.some(
    (child) => child.type === 'text' && child.value.replace(/\s+/g, '') === '@',
  )
  if (links.length !== 1 || !hasDirectivePrefix) return null
  const link = links[0]
  const label = link.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
  const url = link.url.trim()
  if (label === 'video') {
    if (!url) return null
    if (isVideoPath(url) || /^https?:\/\//i.test(url)) {
      return { variant: 'file', sources: [{ src: url }], controls: true }
    }
    return null
  }
  if (label === 'youtube') {
    const id = extractYouTubeId(url)
    if (!id) return null
    return {
      variant: 'youtube',
      sources: [{ src: buildYouTubeEmbedUrl(id) }],
      controls: true,
    }
  }
  if (label === 'bilibili') {
    const id = extractBilibiliId(url)
    if (!id) return null
    return {
      variant: 'bilibili',
      sources: [{ src: buildBilibiliEmbedUrl(id) }],
      controls: true,
    }
  }
  return null
}

export function markdownVideoHandler(state: import('mdast-util-to-hast').State, node: MarkdownVideo) {
  const video = node
  const result = {
    type: 'element' as const,
    tagName: 'div',
    properties: {
      className: ['lp-markdown-video-host'],
      dataLpVideo: JSON.stringify(video.payload),
    },
    children: [],
  }
  state.patch(node, result)
  return state.applyData(node, result)
}
