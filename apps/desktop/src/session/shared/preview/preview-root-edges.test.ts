import { describe, expect, it } from 'vitest'
import { previewRootFor, previewUrl, resolvePreviewRequest } from './preview-url'
import { isOutsideWorkspace, resolveWorkspaceResourcePath } from '../../renderer/lib/editor/workspace-resource-path'

describe('filesystem-root workspaces', () => {
  it.each([['/', '/note.html', '/image.png'], ['C:/', 'C:/note.html', 'C:/image.png']])('retains %s as a workspace root', (workspacePath, documentPath, imagePath) => {
    const root = previewRootFor(workspacePath, documentPath)
    expect(root.kind).toBe('workspace')
    expect(previewUrl('page', root, documentPath)).toBe('gugu-preview://page/note.html')
    expect(resolvePreviewRequest(root, '/image.png')).toBe(imagePath)
    expect(resolveWorkspaceResourcePath({ workspacePath, containingFilePath: documentPath, resourcePath: 'image.png' })).toBe(imagePath)
    expect(isOutsideWorkspace(workspacePath, documentPath)).toBe(false)
  })
})
