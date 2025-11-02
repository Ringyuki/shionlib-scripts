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

const isMultipart = (names: string[]) => {
  // Recognize multi-part by presence of ANY volume indicator, not only the first one
  // Examples: name.7z.002, name.part2.rar, name.r01, name.z01
  const patterns = [
    /\.(7z|zip|rar)\.[0-9]{3,}$/i, // name.7z.002 / name.zip.003 / name.rar.004
    /\.part[0-9]+\.rar$/i, // name.part2.rar
    /\.[rz][0-9]{2}$/i, // name.r01 / name.z01
  ]
  return names.some((n) => patterns.some((re) => re.test(n)))
}

const selectPrimary = (names: string[]): string => {
  const has = (re: RegExp) => names.find((n) => re.test(n))
  return (has(/\.part0*1\.rar$/i) ||
    has(/\.rar$/i) ||
    has(/\.(7z|zip)\.0*1$/i) ||
    names.slice().sort((a, b) => a.localeCompare(b))[0]) as string
}

// Detect missing multipart volumes purely by names (pre-download)
// Supported schemes:
//  - name.(7z|zip|rar).001, .002, ... => expect 001..max contiguous
//  - name.part1.rar, name.part2.rar, ... => expect 1..max contiguous
//  - name.rar + name.r00, name.r01, ... => expect r00..r(max) contiguous (if any rNN present)
const detectMultipartMissing = (
  names: string[],
): { scheme: 'sevenZipStyle' | 'rarPartStyle' | 'rStyle' | null; missingNumbers: number[] } => {
  const lower = names.map((n) => n.toLowerCase())

  // 1) .partN.rar
  const partMatches = lower.map((n) => ({ n, m: n.match(/\.part(\d+)\.rar$/i) })).filter((x) => x.m)
  if (partMatches.length > 0) {
    const nums = partMatches.map((x) => parseInt((x!.m as RegExpMatchArray)[1], 10))
    const max = Math.max(...nums)
    const set = new Set(nums)
    const missing: number[] = []
    for (let i = 1; i <= max; i++) if (!set.has(i)) missing.push(i)
    return { scheme: 'rarPartStyle', missingNumbers: missing }
  }

  // 2) .(7z|zip|rar).001 style
  const volMatches = lower
    .map((n) => ({ n, m: n.match(/\.(7z|zip|rar)\.(\d{3,})$/i) }))
    .filter((x) => x.m)
  if (volMatches.length > 0) {
    const nums = volMatches.map((x) => parseInt((x!.m as RegExpMatchArray)[2], 10))
    const max = Math.max(...nums)
    const set = new Set(nums)
    const missing: number[] = []
    for (let i = 1; i <= max; i++) if (!set.has(i)) missing.push(i)
    return { scheme: 'sevenZipStyle', missingNumbers: missing }
  }

  // 3) .rar + .rNN or .zNN style
  const rMatches = lower.map((n) => ({ n, m: n.match(/\.[rz](\d{2})$/i) })).filter((x) => x.m)
  if (rMatches.length > 0) {
    const nums = rMatches.map((x) => parseInt((x!.m as RegExpMatchArray)[1], 10))
    const max = Math.max(...nums)
    const set = new Set(nums)
    const missing: number[] = []
    for (let i = 0; i <= max; i++) if (!set.has(i)) missing.push(i)
    return { scheme: 'rStyle', missingNumbers: missing }
  }

  return { scheme: null, missingNumbers: [] }
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

export {
  saveFile,
  readFile,
  hasFile,
  deleteFile,
  updateItemInFinalFiles,
  selectPrimary,
  isMultipart,
  detectMultipartMissing,
}
