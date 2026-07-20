import { detectAndDecode } from './encoding'

const WORKER_THRESHOLD = 1024 * 1024

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 32 * 1024
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export async function decodeDocumentBytes(bytes: Uint8Array) {
  if (bytes.length < WORKER_THRESHOLD || typeof Worker === 'undefined') {
    return { ...detectAndDecode(bytes), rawBase64: bytesToBase64(bytes) }
  }

  const worker = new Worker(new URL('./decode-worker.ts', import.meta.url), { type: 'module' })
  const id = crypto.randomUUID()
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer as ArrayBuffer
    : bytes.slice().buffer as ArrayBuffer
  try {
    return await new Promise<ReturnType<typeof detectAndDecode> & { rawBase64: string }>((resolve, reject) => {
      worker.addEventListener('message', (event: MessageEvent<ReturnType<typeof detectAndDecode> & { id: string; rawBase64: string; error?: string }>) => {
        if (event.data.id !== id) return
        if (event.data.error) reject(new Error(event.data.error))
        else resolve(event.data)
      })
      worker.addEventListener('error', (event) => reject(new Error(event.message || '解码 Worker 运行失败')))
      worker.postMessage({ id, buffer }, [buffer])
    })
  } finally {
    worker.terminate()
  }
}
