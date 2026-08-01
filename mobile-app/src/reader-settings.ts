export type ThemeMode = 'light' | 'dark'
export type ThemePreference = ThemeMode | 'system'
export type ExternalResourcePolicy = 'block' | 'ask' | 'allowTrusted'

export type ReaderSettings = {
  themeMode: ThemePreference
  fontSizeLevel: number
  lineHeightLevel: number
  contentWidthLevel: number
  codeSizeLevel: number
  externalResourcePolicy: ExternalResourcePolicy
  immersiveTap: boolean
  rightEdgeToc: boolean
  doubleTapReset: boolean
  volumePageKeys: boolean
  readerToolbarY: number | null
  cacheLimitMb: 128 | 256 | 512
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  themeMode: 'system',
  fontSizeLevel: 2,
  lineHeightLevel: 1,
  contentWidthLevel: 1,
  codeSizeLevel: 1,
  externalResourcePolicy: 'block',
  immersiveTap: true,
  rightEdgeToc: true,
  doubleTapReset: true,
  volumePageKeys: false,
  readerToolbarY: null,
  cacheLimitMb: 256,
}

export function nextThemePreference(current: ThemePreference): ThemePreference {
  if (current === 'system') return 'light'
  if (current === 'light') return 'dark'
  return 'system'
}

export function themePreferenceLabel(theme: ThemePreference) {
  if (theme === 'system') return '跟随系统'
  return theme === 'light' ? '浅色' : '深色'
}

export function nextExternalPolicy(current: ExternalResourcePolicy): ExternalResourcePolicy {
  if (current === 'block') return 'ask'
  if (current === 'ask') return 'allowTrusted'
  return 'block'
}

export function externalPolicyLabel(policy: ExternalResourcePolicy) {
  if (policy === 'ask') return '每次询问'
  if (policy === 'allowTrusted') return '可信文件允许'
  return '默认阻止'
}
