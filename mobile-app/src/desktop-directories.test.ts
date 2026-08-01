import { describe, expect, it } from 'vitest'
import { displayDirectoryFromDocumentPath, isDirectoryPinned, normalizeDirectoryPath, pinDirectory, unpinDirectory } from './desktop-directories'

describe('桌面目录收藏', () => {
  it('按 Windows 路径大小写和尾部分隔符去重', () => {
    const first = pinDirectory([], 'C:\\Docs\\Guide\\', 'Guide')
    const duplicate = pinDirectory(first, 'c:/docs/guide', 'Duplicate')
    expect(duplicate).toHaveLength(1)
    expect(isDirectoryPinned(duplicate, 'C:/DOCS/GUIDE/')).toBe(true)
  })

  it('可以取消收藏且不影响其他目录', () => {
    const directories = pinDirectory(pinDirectory([], 'C:\\Docs', 'Docs'), 'D:\\Notes', 'Notes')
    expect(unpinDirectory(directories, 'c:/docs').map((item) => item.name)).toEqual(['Notes'])
    expect(normalizeDirectoryPath('D:\\Notes\\')).toBe('d:/notes')
  })

  it('可以显示 Windows 规范化长路径和 UNC 文件所在目录', () => {
    expect(displayDirectoryFromDocumentPath('\\\\?\\C:\\Docs\\Guide\\readme.md')).toBe('C:\\Docs\\Guide')
    expect(displayDirectoryFromDocumentPath('\\\\?\\UNC\\server\\share\\notes\\a.html')).toBe('\\\\server\\share\\notes')
  })
})
