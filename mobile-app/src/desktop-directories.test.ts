import { describe, expect, it } from 'vitest'
import {
  displayDirectoryFromDocumentPath,
  displayDirectoryPath,
  isDirectoryPinned,
  normalizeDirectoryPath,
  pinDirectory,
  sortDirectoryDocuments,
  unpinDirectory,
} from './desktop-directories'

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
    expect(displayDirectoryPath('\\\\?\\E:\\技术文档同步\\3D C臂项目')).toBe('E:\\技术文档同步\\3D C臂项目')
    expect(displayDirectoryPath('\\\\?\\UNC\\server\\share\\notes')).toBe('\\\\server\\share\\notes')
    expect(displayDirectoryFromDocumentPath('\\\\?\\C:\\Docs\\Guide\\readme.md')).toBe('C:\\Docs\\Guide')
    expect(displayDirectoryFromDocumentPath('\\\\?\\UNC\\server\\share\\notes\\a.html')).toBe('\\\\server\\share\\notes')
    expect(normalizeDirectoryPath('\\\\?\\C:\\Docs')).toBe(normalizeDirectoryPath('C:\\Docs'))
  })

  it('支持按名称、修改时间和大小排序且不修改原列表', () => {
    const files = [
      { path: 'b', fileName: '文档10.md', size: 10, modifiedAt: 100 },
      { path: 'a', fileName: '文档2.md', size: 30, modifiedAt: 300 },
      { path: 'c', fileName: '附录.md', size: 20, modifiedAt: 200 },
    ]
    expect(sortDirectoryDocuments(files, 'name-asc').map((item) => item.fileName)).toEqual(['附录.md', '文档2.md', '文档10.md'])
    expect(sortDirectoryDocuments(files, 'modified-desc').map((item) => item.path)).toEqual(['a', 'c', 'b'])
    expect(sortDirectoryDocuments(files, 'size-asc').map((item) => item.path)).toEqual(['b', 'c', 'a'])
    expect(files.map((item) => item.path)).toEqual(['b', 'a', 'c'])
  })
})
