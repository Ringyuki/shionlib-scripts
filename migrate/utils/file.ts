import fs from 'fs'
import path from 'path'
import { File, FileItem } from '../interfaces/file.interface'

const BASE_DIR = path.join(process.cwd(), './migrate/files')

const ensurePath = (path: string) => {
  if (!fs.existsSync(path)) {
    fs.mkdirSync(path, { recursive: true })
  }
}

const saveFile = (content: Record<string, any>, file_name: string) => {
  ensurePath(BASE_DIR)
  fs.writeFileSync(path.join(BASE_DIR, file_name), JSON.stringify(content, null, 2))
}

const readFile = <T>(file_name: string): T | null => {
  ensurePath(BASE_DIR)
  if (!fs.existsSync(path.join(BASE_DIR, file_name))) {
    return null
  }
  return JSON.parse(fs.readFileSync(path.join(BASE_DIR, file_name), 'utf8'))
}

const hasFile = (p: string) => {
  return fs.existsSync(p)
}

const deleteFile = (p: string) => {
  if (!fs.existsSync(p)) return
  const stat = fs.lstatSync(p)
  if (stat.isDirectory()) {
    fs.rmSync(p, { recursive: true, force: true })
  } else {
    fs.unlinkSync(p)
  }
}

const updateItemInFinalFiles = (
  match: (item: FileItem) => boolean,
  updater: (item: FileItem) => void,
) => {
  const files = readFile<File[]>('final_files.json') || []
  let changed = false
  for (const f of files) {
    for (const it of f.items) {
      if (match(it)) {
        updater(it)
        changed = true
      }
    }
  }
  if (changed) {
    saveFile(files, 'final_files.json')
  }
}

export { saveFile, readFile, hasFile, deleteFile, updateItemInFinalFiles }
