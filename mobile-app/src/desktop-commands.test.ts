import { describe, expect, it } from 'vitest'
import { filterCommands, findShortcutConflicts, normalizeShortcut } from './desktop-commands'

describe('Windows 命令注册表', () => {
  it('规范化快捷键并检测冲突', () => {
    expect(normalizeShortcut('shift+ctrl+p')).toBe('Ctrl+Shift+P')
    expect(findShortcutConflicts([
      { id: 'a', title: 'A', shortcut: 'Ctrl+O', run: () => undefined },
      { id: 'b', title: 'B', shortcut: 'control+o', run: () => undefined },
    ])).toEqual([{ shortcut: 'Ctrl+O', commandIds: ['a', 'b'] }])
  })

  it('按标题和关键词过滤可用命令', () => {
    const commands = [
      { id: 'open', title: '打开文件', keywords: ['document'], run: () => undefined },
      { id: 'disabled', title: '关闭', enabled: () => false, run: () => undefined },
    ]
    expect(filterCommands(commands, 'document').map((item) => item.id)).toEqual(['open'])
  })
})
