import { useEffect, useMemo, useState } from 'react'
import { Film, Maximize2, Minimize2 } from 'lucide-react'
import type { MarkdownVideoPayload } from './markdown-media'

type MarkdownVideoProps = {
  payload: MarkdownVideoPayload
  resolveSrc: (src: string) => string
}

export default function MarkdownVideo({ payload, resolveSrc }: MarkdownVideoProps) {
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const sources = useMemo(
    () => payload.sources.map((source) => ({
      ...source,
      resolvedSrc: resolveSrc(source.src),
    })),
    [payload.sources, resolveSrc],
  )
  const title = payload.label || sources[0]?.src.split(/[\\/]/).pop() || '视频'

  useEffect(() => {
    if (!expanded) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  if (failed) {
    return (
      <span className="img-fallback markdown-video-fallback">
        <Film size={20} />
        <span>{title}</span>
      </span>
    )
  }

  if (payload.variant === 'youtube' || payload.variant === 'bilibili') {
    const embedUrl = sources[0]?.resolvedSrc ?? ''
    return (
      <div
        className="markdown-video markdown-video-embed"
        style={frameStyle(payload.width, payload.height)}
      >
        <iframe
          src={embedUrl}
          title={title}
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    )
  }

  return (
    <span className={`markdown-video-frame${expanded ? ' is-expanded' : ''}`}>
      <video
        className="markdown-video"
        controls={payload.controls}
        controlsList="nofullscreen"
        playsInline
        poster={payload.poster ? resolveSrc(payload.poster) : undefined}
        loop={payload.loop}
        muted={payload.muted}
        preload={(payload.preload as 'auto' | 'metadata' | 'none' | undefined) ?? 'metadata'}
        width={expanded || !payload.width ? undefined : Number(payload.width) || undefined}
        height={expanded || !payload.height ? undefined : Number(payload.height) || undefined}
        style={expanded ? undefined : frameStyle(payload.width, payload.height)}
        onError={() => setFailed(true)}
      >
        {sources.map((source) => (
          <source key={`${source.resolvedSrc}:${source.type ?? ''}`} src={source.resolvedSrc} type={source.type} />
        ))}
      </video>
      <button
        type="button"
        className="markdown-video-expand"
        aria-label={expanded ? '退出全屏' : '全屏播放'}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
    </span>
  )
}

function frameStyle(width?: string, height?: string) {
  if (!width && !height) return undefined
  return {
    width: width ? (/^\d+$/.test(width) ? `${width}px` : width) : undefined,
    height: height ? (/^\d+$/.test(height) ? `${height}px` : height) : undefined,
  }
}
