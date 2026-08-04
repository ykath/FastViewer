import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Archive, BookOpen, FileCode2, Moon, ShieldCheck, SlidersHorizontal, Sun, X } from 'lucide-react'
import { readPerformanceMetrics } from './performance-metrics'
import {
  externalPolicyLabel,
  nextExternalPolicy,
  nextThemePreference,
  themePreferenceLabel,
} from './reader-settings'
import type { ReaderSettings, ThemeMode } from './reader-settings'
import { clearNativeRegenerableCache, formatStorageBytes, getNativeStorageStatus } from './native-storage'
import type { NativeStorageStatus } from './native-storage'
import { desktopPlatform } from './desktop-platform'

type Props = {
  settings: ReaderSettings
  resolvedTheme: ThemeMode
  onSetSettings: (settings: ReaderSettings) => void
}

export default function SettingsPage({ settings, resolvedTheme, onSetSettings }: Props) {
  const [infoSheet, setInfoSheet] = useState<'help' | 'privacy' | 'performance' | 'storage' | null>(null)
  const [storageStatus, setStorageStatus] = useState<NativeStorageStatus | null>(null)
  const [clearingStorage, setClearingStorage] = useState(false)
  const [htmlOpenWith, setHtmlOpenWith] = useState(settings.desktopHtmlOpenWith)
  const isDesktop = desktopPlatform.isDesktop()
  const performanceMetrics = readPerformanceMetrics().slice(-20).reverse()
  useEffect(() => {
    if (infoSheet !== 'storage') return
    void getNativeStorageStatus().then(setStorageStatus).catch(() => setStorageStatus(null))
  }, [infoSheet])
  useEffect(() => {
    if (!isDesktop) return
    void desktopPlatform.getHtmlOpenWith().then((enabled) => {
      setHtmlOpenWith(enabled)
      if (enabled !== settings.desktopHtmlOpenWith) onSetSettings({ ...settings, desktopHtmlOpenWith: enabled })
    }).catch(() => undefined)
  // Native association is read once when the settings page opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop])
  return (
    <section className="page page-settings" aria-label="设置">
      <header className="simple-header"><div><p className="eyebrow">Settings</p><h1>设置</h1></div></header>
      <section className="settings-list">
        <SettingRow icon={resolvedTheme === 'light' ? <Sun size={19} /> : <Moon size={19} />} title="阅读主题" description="跟随系统、浅色和深色即时切换" value={themePreferenceLabel(settings.themeMode)} onClick={() => onSetSettings({ ...settings, themeMode: nextThemePreference(settings.themeMode) })} />
        <SettingRow icon={<ShieldCheck size={19} />} title="HTML 外部资源" description="控制远程图片、样式和字体的加载" value={externalPolicyLabel(settings.externalResourcePolicy)} onClick={() => onSetSettings({ ...settings, externalResourcePolicy: nextExternalPolicy(settings.externalResourcePolicy) })} />
        <SettingRow icon={<SlidersHorizontal size={19} />} title="字号档位" description="阅读页可通过 A- / A+ 调整" value={`${settings.fontSizeLevel + 1}/5`} />
        <SettingRow icon={<SlidersHorizontal size={19} />} title="正文行高" description="紧凑、标准和宽松三档" value={['紧凑', '标准', '宽松'][settings.lineHeightLevel] ?? '标准'} onClick={() => onSetSettings({ ...settings, lineHeightLevel: (settings.lineHeightLevel + 1) % 3 })} />
        <SettingRow icon={<SlidersHorizontal size={19} />} title="内容宽度" description="窄栏、标准和铺满三档" value={['窄栏', '标准', '铺满'][settings.contentWidthLevel] ?? '标准'} onClick={() => onSetSettings({ ...settings, contentWidthLevel: (settings.contentWidthLevel + 1) % 3 })} />
        <SettingRow icon={<FileCode2 size={19} />} title="代码字号" description="独立调整代码块显示大小" value={['小', '标准', '大'][settings.codeSizeLevel] ?? '标准'} onClick={() => onSetSettings({ ...settings, codeSizeLevel: (settings.codeSizeLevel + 1) % 3 })} />
        <SettingRow icon={<BookOpen size={19} />} title="点击沉浸阅读" description="点击正文空白区域隐藏或显示工具栏" value={settings.immersiveTap ? '开启' : '关闭'} onClick={() => onSetSettings({ ...settings, immersiveTap: !settings.immersiveTap })} />
        <SettingRow icon={<BookOpen size={19} />} title="右侧目录触发条" description="显示阅读区右侧的目录显隐按钮" value={settings.rightEdgeToc ? '开启' : '关闭'} onClick={() => onSetSettings({ ...settings, rightEdgeToc: !settings.rightEdgeToc })} />
        <SettingRow icon={<BookOpen size={19} />} title="双击恢复排版" description="双击正文空白区域恢复标准字号和宽度" value={settings.doubleTapReset ? '开启' : '关闭'} onClick={() => onSetSettings({ ...settings, doubleTapReset: !settings.doubleTapReset })} />
        <SettingRow icon={<BookOpen size={19} />} title="音量键翻页" description="阅读时使用音量键向上或向下翻页" value={settings.volumePageKeys ? '开启' : '关闭'} onClick={() => onSetSettings({ ...settings, volumePageKeys: !settings.volumePageKeys })} />
        <SettingRow icon={<Archive size={19} />} title="可再生缓存上限" description="解压目录、渲染缓存和缩略图采用 LRU 清理" value={`${settings.cacheLimitMb} MB`} onClick={() => onSetSettings({ ...settings, cacheLimitMb: settings.cacheLimitMb === 128 ? 256 : settings.cacheLimitMb === 256 ? 512 : 128 })} />
        <SettingRow icon={<Archive size={19} />} title="存储空间" description="查看耐久数据、缓存、外部打开队列和剩余空间" value="查看" onClick={() => setInfoSheet('storage')} />
        <SettingRow icon={<ShieldCheck size={19} />} title="HTML 安全沙盒" description="默认禁用脚本、自动跳转和自动下载" value="启用" />
        <SettingRow icon={<Archive size={19} />} title="本地文件库" description="保存到 App 内的文件仅保存在本机" value="本地" />
        {isDesktop && <SettingRow icon={<FileCode2 size={19} />} title="HTML 打开方式" description="注册或撤销当前用户的 LightPage HTML 打开方式" value={htmlOpenWith ? '已注册' : '未注册'} onClick={() => {
          const enabled = !htmlOpenWith
          void desktopPlatform.setHtmlOpenWith(enabled).then(() => {
            setHtmlOpenWith(enabled)
            onSetSettings({ ...settings, desktopHtmlOpenWith: enabled })
          })
        }} />}
        {isDesktop && <SettingRow icon={<BookOpen size={19} />} title="Windows 最近文档" description="将成功打开的本地文件加入系统最近文档" value={settings.desktopRecentDocuments ? '开启' : '关闭'} onClick={() => onSetSettings({ ...settings, desktopRecentDocuments: !settings.desktopRecentDocuments })} />}
        <SettingRow icon={<BookOpen size={19} />} title="使用帮助" description="文件打开、安全权限与导出说明" value="查看" onClick={() => setInfoSheet('help')} />
        <SettingRow icon={<ShieldCheck size={19} />} title="隐私说明" description="文档默认仅在本机处理，不自动上传" value="查看" onClick={() => setInfoSheet('privacy')} />
        <SettingRow icon={<FileCode2 size={19} />} title="性能诊断" description="仅保存在本机的最近耗时记录" value={`${performanceMetrics.length} 条`} onClick={() => setInfoSheet('performance')} />
        <SettingRow icon={<FileCode2 size={19} />} title="版本" description="HTML 与 Markdown 阅读一致性优化版本" value="1.5.1" />
      </section>
      {infoSheet === 'help' && <InfoSheet title="使用帮助" onClose={() => setInfoSheet(null)}><p>可从首页、文件管理器或其他 App 打开 Markdown、HTML、ZIP 与 RAR；10 MB 以上文件默认进入源码模式。</p><p>HTML 默认禁用脚本、表单、弹窗和远程资源。同目录图片与 CSS 可在当前文件的“HTML 权限”中授权。</p><p>文件菜单支持真实 PDF、原始文件，以及当前区域、全文或分页图片导出。</p></InfoSheet>}
      {infoSheet === 'privacy' && <InfoSheet title="隐私说明" onClose={() => setInfoSheet(null)}><p>文档正文、原始字节、阅读位置与搜索内容默认仅保存在本机，不会自动上传。</p><p>远程 HTML 资源仅在你明确允许时加载；外部链接、系统分享和目录授权均由你主动触发。</p><p>删除记录会清理正文与对应资源缓存；本地性能日志不包含文档正文。</p></InfoSheet>}
      {infoSheet === 'performance' && (
        <Sheet title="本地性能诊断" onClose={() => setInfoSheet(null)}>
          <p className="sheet-description">只记录操作名称、耗时和文件规模，不含文档正文，也不会自动发送。</p>
          <div className="metric-list">
            {performanceMetrics.length === 0 ? <p className="sheet-description">暂无记录。打开、搜索或导出文档后会显示在这里。</p> : performanceMetrics.map((metric) => <div key={`${metric.recordedAt}-${metric.name}`}><strong>{performanceMetricLabel(metric.name)}</strong><span>{metric.durationMs.toFixed(1)} ms</span></div>)}
          </div>
        </Sheet>
      )}
      {infoSheet === 'storage' && (
        <Sheet title="存储空间" onClose={() => setInfoSheet(null)}>
          {!storageStatus ? <p className="sheet-description">当前平台不支持存储统计，或统计暂时不可用。</p> : (
            <div className="metric-list">
              <div><strong>耐久数据</strong><span>{formatStorageBytes(storageStatus.durableBytes)}</span></div>
              <div><strong>可再生缓存</strong><span>{formatStorageBytes(storageStatus.regenerableBytes)}</span></div>
              <div><strong>外部打开队列</strong><span>{formatStorageBytes(storageStatus.openQueueBytes)}</span></div>
              <div><strong>分享临时文件</strong><span>{formatStorageBytes(storageStatus.shareBytes)}</span></div>
              <div><strong>设备剩余空间</strong><span>{formatStorageBytes(storageStatus.freeBytes)}</span></div>
            </div>
          )}
          <button className="primary-action compact" type="button" disabled={!storageStatus || clearingStorage} onClick={() => {
            setClearingStorage(true)
            void clearNativeRegenerableCache(settings.cacheLimitMb)
              .then(setStorageStatus)
              .finally(() => setClearingStorage(false))
          }}>{clearingStorage ? '清理中…' : '仅清理可再生缓存'}</button>
        </Sheet>
      )}
    </section>
  )
}

function SettingRow({ icon, title, description, value, onClick }: { icon: ReactNode; title: string; description: string; value: string; onClick?: () => void }) {
  const Component = onClick ? 'button' : 'div'
  return <Component className="setting-row" type={onClick ? 'button' : undefined} onClick={onClick}><span className="setting-icon">{icon}</span><span className="setting-copy"><span className="setting-title">{title}</span><span className="setting-description">{description}</span></span><span className="setting-value">{value}</span></Component>
}

function InfoSheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <Sheet title={title} onClose={onClose}><div className="info-copy">{children}</div></Sheet>
}

function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}><section className="sheet" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><header className="sheet-header"><h2>{title}</h2><button className="icon-button" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>{children}</section></div>
}

function performanceMetricLabel(name: string) {
  if (name === 'file-open') return '文件打开计算'
  if (name === 'document-search') return '文内搜索计算'
  if (name === 'image-export') return '图片导出'
  if (name === 'pdf-export') return 'PDF 导出'
  return name
}
