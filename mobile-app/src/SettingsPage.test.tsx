// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from './SettingsPage'
import { desktopPlatform } from './desktop-platform'
import { DEFAULT_READER_SETTINGS } from './reader-settings'
import { version } from '../package.json'

vi.mock('./desktop-platform', () => ({ desktopPlatform: {
  isDesktop: vi.fn(() => true),
  getHtmlOpenWith: vi.fn(async () => false),
  getExternalOpenMode: vi.fn(async () => 'currentWindow'),
  setExternalOpenMode: vi.fn(async () => undefined),
} }))

const renderSettings = () => render(<SettingsPage settings={DEFAULT_READER_SETTINGS} resolvedTheme="light" onSetSettings={vi.fn()} />)

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe('desktop file open preference', () => {
  it('defaults to the current window, saves a change and restores the saved choice', async () => {
    const view = renderSettings()
    const row = await screen.findByRole('button', { name: /双击文件打开方式.*当前窗口$/ })
    fireEvent.click(row)
    await waitFor(() => expect(desktopPlatform.setExternalOpenMode).toHaveBeenCalledWith('newWindow'))
    await screen.findByRole('button', { name: /双击文件打开方式.*新窗口$/ })
    view.unmount()
    vi.mocked(desktopPlatform.getExternalOpenMode).mockResolvedValueOnce('newWindow')
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: /双击文件打开方式.*新窗口$/ }))
    await waitFor(() => expect(desktopPlatform.setExternalOpenMode).toHaveBeenLastCalledWith('currentWindow'))
    await screen.findByRole('button', { name: /双击文件打开方式.*当前窗口$/ })
    expect(screen.getByText(version)).toBeTruthy()
  })

  it('keeps the saved choice and shows an error when persistence fails', async () => {
    vi.mocked(desktopPlatform.setExternalOpenMode).mockRejectedValueOnce(new Error('disk full'))
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: /双击文件打开方式.*当前窗口$/ }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '保存失败，打开方式未更改，请重试。')
    expect(screen.getByRole('button', { name: /双击文件打开方式.*当前窗口$/ })).toHaveProperty('disabled', false)
  })

  it('refreshes the shared preference when returning from another window', async () => {
    renderSettings()
    await screen.findByRole('button', { name: /双击文件打开方式.*当前窗口$/ })
    vi.mocked(desktopPlatform.getExternalOpenMode).mockResolvedValueOnce('newWindow')
    fireEvent.focus(window)
    await screen.findByRole('button', { name: /双击文件打开方式.*新窗口$/ })
  })

  it('does not show the window preference on Android or the web', () => {
    vi.mocked(desktopPlatform.isDesktop).mockReturnValueOnce(false)
    renderSettings()
    expect(screen.queryByText('双击文件打开方式')).toBeNull()
    expect(desktopPlatform.getExternalOpenMode).not.toHaveBeenCalled()
  })
})
