import path from 'node:path'

const parseFilePath = (key: string): { folders: string[]; file_name: string } => {
  const { dir, base } = path.posix.parse(key)
  const folders = dir
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
  return { folders, file_name: base || '' }
}

export { parseFilePath }
