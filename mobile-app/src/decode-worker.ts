/// <reference lib="webworker" />
import { detectAndDecode } from './encoding'

type DecodeRequest = { id: string; buffer: ArrayBuffer }

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 32 * 1024
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

self.addEventListener('message', (event: MessageEvent<DecodeRequest>) => {
  try {
    const bytes = new Uint8Array(event.data.buffer)
    const result = detectAndDecode(bytes)
    self.postMessage({ id: event.data.id, ...result, rawBase64: bytesToBase64(bytes) })
  } catch (error) {
    self.postMessage({
      id: event.data.id,
      error: error instanceof Error ? error.message : '文件解码失败',
    })
  }
})

export {}
