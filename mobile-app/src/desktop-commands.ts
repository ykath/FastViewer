export type DesktopCommand = {
  id: string
  title: string
  keywords?: string[]
  shortcut?: string
  enabled?: () => boolean
  run: () => void | Promise<void>
}

export type ShortcutConflict = {
  shortcut: string
  commandIds: string[]
}

export function normalizeShortcut(shortcut: string) {
  const aliases: Record<string, string> = { control: 'Ctrl', ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: 'Meta', cmd: 'Meta' }
  const parts = shortcut.split('+').map((part) => part.trim()).filter(Boolean)
  const modifiers = new Set(parts.slice(0, -1).map((part) => aliases[part.toLowerCase()] ?? part))
  const key = parts.at(-1)?.length === 1 ? parts.at(-1)?.toUpperCase() : parts.at(-1)
  return [...['Ctrl', 'Alt', 'Shift', 'Meta'].filter((modifier) => modifiers.has(modifier)), key].filter(Boolean).join('+')
}

export function shortcutFromEvent(event: KeyboardEvent) {
  const modifierKeys = new Set(['Control', 'Shift', 'Alt', 'Meta'])
  if (modifierKeys.has(event.key)) return ''
  const parts = [
    event.ctrlKey && 'Ctrl',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
    event.metaKey && 'Meta',
    event.key.length === 1 ? event.key.toUpperCase() : event.key,
  ].filter(Boolean)
  return normalizeShortcut(parts.join('+'))
}

export function findShortcutConflicts(commands: DesktopCommand[]): ShortcutConflict[] {
  const shortcuts = new Map<string, string[]>()
  commands.forEach((command) => {
    if (!command.shortcut) return
    const normalized = normalizeShortcut(command.shortcut)
    shortcuts.set(normalized, [...(shortcuts.get(normalized) ?? []), command.id])
  })
  return Array.from(shortcuts, ([shortcut, commandIds]) => ({ shortcut, commandIds }))
    .filter((item) => item.commandIds.length > 1)
}

export function isTextEditingTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

export function matchCommandShortcut(event: KeyboardEvent, commands: DesktopCommand[]) {
  if (isTextEditingTarget(event.target) && !event.ctrlKey && !event.metaKey && event.key !== 'Escape') return null
  const shortcut = shortcutFromEvent(event)
  return commands.find((command) => command.shortcut
    && normalizeShortcut(command.shortcut) === shortcut
    && (command.enabled?.() ?? true)) ?? null
}

export function filterCommands(commands: DesktopCommand[], query: string) {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return commands.filter((command) => command.enabled?.() ?? true)
  return commands.filter((command) => {
    if (!(command.enabled?.() ?? true)) return false
    return [command.title, command.id, ...(command.keywords ?? [])].join(' ').toLocaleLowerCase().includes(normalized)
  })
}
