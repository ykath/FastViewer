import { Capacitor } from '@capacitor/core'

export type NativeStorageStatus = {
  durableBytes: number
  regenerableBytes: number
  openQueueBytes: number
  shareBytes: number
  freeBytes: number
}

type NativeStoragePlugin = {
  getStorageStatus: () => Promise<NativeStorageStatus>
  clearRegenerableCache: (options: { limitMb: number; force?: boolean }) => Promise<{ deleted: number; remainingBytes: number }>
}

const NativeStorage = (Capacitor as unknown as { Plugins: Record<string, unknown> }).Plugins.FastViewerFiles as NativeStoragePlugin

export async function getNativeStorageStatus() {
  if (!Capacitor.isNativePlatform()) return null
  return NativeStorage.getStorageStatus()
}

export async function clearNativeRegenerableCache(limitMb: number) {
  if (!Capacitor.isNativePlatform()) return null
  await NativeStorage.clearRegenerableCache({ limitMb, force: true })
  return NativeStorage.getStorageStatus()
}

export function formatStorageBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
