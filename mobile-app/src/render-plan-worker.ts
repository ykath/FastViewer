/// <reference lib="webworker" />
import { createRenderPlan } from './render-plan'

self.addEventListener('message', (event: MessageEvent<{ id: string; content: string }>) => {
  try {
    self.postMessage({ id: event.data.id, plan: createRenderPlan(event.data.content) })
  } catch (error) {
    self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : '无法生成渲染计划' })
  }
})

export {}
