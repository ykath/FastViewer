import type { MarkdownVideoPayload } from './markdown-media'
import type { Position } from 'mdast'

export type MarkdownVideo = {
  type: 'markdownVideo'
  payload: MarkdownVideoPayload
  position?: Position
}

declare module 'mdast' {
  interface RootContentMap {
    markdownVideo: import('./mdast-markdown-video').MarkdownVideo
  }
}
