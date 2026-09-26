import { Capacitor } from '@capacitor/core'
import { Share } from '@capacitor/share'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { base64ToBytes } from '../encoding'
import { FastViewerFiles, type ImageExportMode, type ToastState } from '../app/types'
import { clamp, inferDocumentMime } from '../app/records'
import { desktopPlatform } from '../desktop-platform'
import { backgroundTasks } from '../background-tasks'
import { finishPerformanceSpan, startPerformanceSpan } from '../performance-metrics'
import { buildSafeHtmlDocument, rewriteRelativeResources, type HtmlRenderInfo } from '../html-processing'
import type { DocumentRecord } from '../document-types'
import type { ThemeMode } from '../reader-settings'
import {
  PRINT_CSS,
  buildPrintDocument,
  calculateExportScale,
  canvasToPngBytes,
  captureHtmlFrameAsCanvas,
  captureHtmlSourceAsCanvas,
  cropCanvas,
  escapeHtml,
  paginateCanvas,
} from './export-capture'

export function useReaderExport({
  doc,
  isDesktop,
  onShowToast,
  setMenuOpen,
  contentRef,
  iframeRef,
  scrollRef,
  htmlInfo,
  resolvedTheme,
  allowScripts,
  allowExternalResources,
}: {
  doc: DocumentRecord
  isDesktop: boolean
  onShowToast: (message: string, tone?: ToastState['tone']) => void
  setMenuOpen: Dispatch<SetStateAction<boolean>>
  contentRef: RefObject<HTMLElement | null>
  iframeRef: RefObject<HTMLIFrameElement | null>
  scrollRef: RefObject<HTMLElement | null>
  htmlInfo: HtmlRenderInfo | null
  resolvedTheme: ThemeMode
  allowScripts: boolean
  allowExternalResources: boolean
}) {
  const [exporting, setExporting] = useState(false)
  const shareOriginalFile = async () => {
    if (exporting) return
    setExporting(true)
    setMenuOpen(false)
    try {
      if (isDesktop) {
        const bytes = doc.rawBase64
          ? base64ToBytes(doc.rawBase64)
          : new TextEncoder().encode(doc.content)
        const saved = await desktopPlatform.saveOriginal(bytes, doc.fileName)
        if (saved) onShowToast('原文件已导出', 'success')
        return
      }
      if (!Capacitor.isNativePlatform()) {
        const blob = doc.rawBase64
          ? new Blob([base64ToBytes(doc.rawBase64).buffer as ArrayBuffer], { type: inferDocumentMime(doc) })
          : new Blob([doc.content], { type: 'text/plain;charset=utf-8' })
        const a = window.document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = doc.fileName
        a.click()
        URL.revokeObjectURL(a.href)
        onShowToast('已下载文件', 'success')
        return
      }

      const path = `share/${doc.fileName}`
      if (doc.rawBase64) {
        await Filesystem.writeFile({ path, data: doc.rawBase64, directory: Directory.Cache, recursive: true })
      } else {
        await Filesystem.writeFile({ path, data: doc.content, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true })
      }

      const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
      await Share.share({ title: doc.fileName, url: uri, dialogTitle: '分享文件' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '未知错误'
      if (!msg.includes('cancel') && !msg.includes('dismiss')) {
        onShowToast(`分享失败：${msg}`, 'warning')
      }
    } finally {
      setExporting(false)
    }
  }

  const exportPdf = async () => {
    if (exporting) return
    setExporting(true)
    setMenuOpen(false)
    const exportStartedAt = startPerformanceSpan()
    const { task, signal } = backgroundTasks.begin('pdf-export', `正在导出 ${doc.fileName}`)
    try {
      backgroundTasks.update(task.id, { progress: 0.1 })
      if (Capacitor.isNativePlatform()) {
        const content = doc.fileType === 'html' && htmlInfo
          ? htmlInfo.plainText
          : doc.content
        const result = await FastViewerFiles.createPdf({ title: doc.fileName, content })
        if (signal.aborted) throw new DOMException('导出已取消', 'AbortError')
        backgroundTasks.update(task.id, { progress: 0.85 })
        await Share.share({
          title: `${doc.fileName} PDF`,
          files: [result.uri],
          dialogTitle: '分享 PDF',
        })
        onShowToast(`PDF 已生成（${result.pageCount} 页）`, 'success')
        finishPerformanceSpan('pdf-export', exportStartedAt, { pages: result.pageCount, bytes: result.size })
        return
      }

      let printHtml: string
      if (doc.fileType === 'html' && htmlInfo) {
        printHtml = htmlInfo.srcDoc.replace('</head>', `${PRINT_CSS}</head>`)
      } else {
        const rendered = contentRef.current?.innerHTML ?? `<pre>${escapeHtml(doc.content)}</pre>`
        printHtml = buildPrintDocument(doc.fileName, rendered)
      }

      const printFrame = window.document.createElement('iframe')
      printFrame.style.cssText = 'position:fixed;left:-9999px;width:800px;height:600px;'
      window.document.body.appendChild(printFrame)

      const frameDoc = printFrame.contentDocument ?? printFrame.contentWindow?.document
      if (!frameDoc) throw new Error('无法创建打印窗口')

      frameDoc.open()
      frameDoc.write(printHtml)
      frameDoc.close()
      backgroundTasks.update(task.id, { progress: 0.45 })

      await new Promise<void>((resolve) => {
        printFrame.onload = () => resolve()
        setTimeout(resolve, 1500)
      })

      if (signal.aborted) throw new DOMException('导出已取消', 'AbortError')
      backgroundTasks.update(task.id, { progress: 0.85 })

      printFrame.contentWindow?.print()
      setTimeout(() => printFrame.remove(), 3000)
      onShowToast('已调起浏览器打印/PDF 导出', 'success')
      finishPerformanceSpan('pdf-export', exportStartedAt, { browserPrint: true })
      backgroundTasks.complete(task.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '未知错误'
      if (signal.aborted) onShowToast('PDF 导出已取消', 'warning')
      else {
        backgroundTasks.fail(task.id, msg)
        onShowToast(`PDF 导出失败：${msg}`, 'warning')
      }
    } finally {
      if (!signal.aborted && backgroundTasks.list().find((item) => item.id === task.id)?.status === 'running') backgroundTasks.complete(task.id)
      setExporting(false)
    }
  }

  const shareAsImage = async (mode: ImageExportMode) => {
    if (exporting) return
    setExporting(true)
    setMenuOpen(false)
    const exportStartedAt = startPerformanceSpan()
    const { task, signal } = backgroundTasks.begin('image-export', `正在生成 ${doc.fileName} 图片`)
    try {
      let targetElement: HTMLElement | null = null
      let canvas: HTMLCanvasElement

      if (doc.fileType === 'html') {
        if (allowScripts) {
          const exportHtml = buildSafeHtmlDocument(
            doc.archiveResources
              ? rewriteRelativeResources(doc.content, doc.fileName, doc.archiveRelativePath, doc.archiveResources)
              : doc.content,
            { allowExternalResources, allowScripts: false, allowForms: false },
          )
          canvas = await captureHtmlSourceAsCanvas(exportHtml.srcDoc, resolvedTheme)
        } else {
          canvas = await captureHtmlFrameAsCanvas(iframeRef.current, resolvedTheme)
        }
      } else {
        targetElement = contentRef.current

        if (!targetElement) throw new Error('无法获取内容区域')

        const { default: html2canvas } = await import('html2canvas-pro')
        const width = Math.ceil(targetElement.getBoundingClientRect().width || 375)
        const height = Math.max(targetElement.scrollHeight, Math.ceil(targetElement.getBoundingClientRect().height))
        canvas = await html2canvas(targetElement, {
          useCORS: true,
          scale: calculateExportScale(width, height),
          backgroundColor: resolvedTheme === 'dark' ? '#171e1a' : '#fffdf8',
          windowWidth: width,
        })
      }
      if (signal.aborted) throw new DOMException('导出已取消', 'AbortError')
      backgroundTasks.update(task.id, { progress: 0.55 })

      let outputCanvases = [canvas]
      if (mode === 'visible') {
        const scroller = scrollRef.current
        const viewportRatio = scroller ? Math.min(1, scroller.clientHeight / Math.max(1, scroller.scrollHeight)) : 1
        const progress = scroller ? scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight) : 0
        const cropHeight = Math.max(1, Math.round(canvas.height * viewportRatio))
        const cropTop = Math.round((canvas.height - cropHeight) * clamp(progress, 0, 1))
        outputCanvases = [cropCanvas(canvas, cropTop, cropHeight)]
      } else if (mode === 'pages') {
        outputCanvases = paginateCanvas(canvas)
      }

      if (!Capacitor.isNativePlatform()) {
        if (isDesktop) {
          const baseName = doc.fileName.replace(/\.[^.]+$/, '')
          const imageFiles = await Promise.all(outputCanvases.map(async (outputCanvas, index) => ({
            fileName: `${baseName}${outputCanvases.length > 1 ? `-${index + 1}` : ''}.png`,
            bytes: await canvasToPngBytes(outputCanvas),
          })))
          if (signal.aborted) throw new DOMException('导出已取消', 'AbortError')
          backgroundTasks.update(task.id, { progress: 0.85 })
          const saved = await desktopPlatform.saveImages(imageFiles)
          if (!saved) return
          finishPerformanceSpan('image-export', exportStartedAt, {
            mode,
            pages: outputCanvases.length,
            pixels: outputCanvases.reduce((total, item) => total + item.width * item.height, 0),
          })
          onShowToast(`已导出 ${outputCanvases.length} 张图片`, 'success')
          return
        }
        outputCanvases.forEach((outputCanvas, index) => {
          const a = window.document.createElement('a')
          a.href = outputCanvas.toDataURL('image/png')
          a.download = `${doc.fileName.replace(/\.[^.]+$/, '')}${outputCanvases.length > 1 ? `-${index + 1}` : ''}.png`
          a.click()
        })
        finishPerformanceSpan('image-export', exportStartedAt, {
          mode,
          pages: outputCanvases.length,
          pixels: outputCanvases.reduce((total, item) => total + item.width * item.height, 0),
        })
        onShowToast(`已下载 ${outputCanvases.length} 张图片`, 'success')
        return
      }

      const uris: string[] = []
      for (let index = 0; index < outputCanvases.length; index += 1) {
        if (signal.aborted) throw new DOMException('导出已取消', 'AbortError')
        const suffix = outputCanvases.length > 1 ? `-${index + 1}` : ''
        const imgPath = `share/${doc.fileName.replace(/\.[^.]+$/, '')}${suffix}.png`
        const base64Data = outputCanvases[index].toDataURL('image/png').split(',')[1]
        await Filesystem.writeFile({ path: imgPath, data: base64Data, directory: Directory.Cache, recursive: true })
        const { uri } = await Filesystem.getUri({ path: imgPath, directory: Directory.Cache })
        uris.push(uri)
      }
      await Share.share({ title: `${doc.fileName} 图片`, files: uris, dialogTitle: '分享图片' })
      finishPerformanceSpan('image-export', exportStartedAt, {
        mode,
        pages: outputCanvases.length,
        pixels: outputCanvases.reduce((total, item) => total + item.width * item.height, 0),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '未知错误'
      if (signal.aborted) onShowToast('图片生成已取消', 'warning')
      else if (!msg.includes('cancel') && !msg.includes('dismiss')) {
        backgroundTasks.fail(task.id, msg)
        onShowToast(`图片生成失败：${msg}`, 'warning')
      }
    } finally {
      if (!signal.aborted && backgroundTasks.list().find((item) => item.id === task.id)?.status === 'running') backgroundTasks.complete(task.id)
      setExporting(false)
    }
  }

  return { exporting, setExporting, shareOriginalFile, exportPdf, shareAsImage }
}
