import { start as startDownload } from './libs/download'
import { start as start7zip } from './libs/7zip'
import { readFile, deleteFile, hasFile, updateItemInFinalFiles } from './utils/file'
import { File, FileItem } from './interfaces/file.interface'
import path from 'path'
import { uploadFile } from './libs/upload'
import { stripExt } from './utils/strip-ext'
import { DOWNLOAD_DIR, EXTRACTED_DIR, COMPRESSED_DIR } from './constants/dirs'
import { FileStatus } from './interfaces/file.interface'

const process = async (file: File) => {
  const { items, platform, game_id } = file
  if (!items.length) return

  const firstName = items[0].o_file_name
  const extractedName = stripExt(firstName, { all: true })
  const extractedPath = path.join(EXTRACTED_DIR, extractedName)

  const selectPrimary = (names: string[]): string => {
    const has = (re: RegExp) => names.find((n) => re.test(n))
    return (has(/\.part0*1\.rar$/i) ||
      has(/\.rar$/i) ||
      has(/\.(7z|zip)\.0*1$/i) ||
      names.slice().sort((a, b) => a.localeCompare(b))[0]) as string
  }
  const names = items.map((i) => i.o_file_name)
  const primaryName = selectPrimary(names)

  try {
    for (const it of items) updateFileItemStatus(file, it, { status: FileStatus.PROCESSING })

    for (const it of items) {
      const p = path.join(DOWNLOAD_DIR, it.o_file_name)
      const needDownload = hasFile(`${p}.aria2`) || !hasFile(p)
      if (needDownload) {
        let retryCount = 0
        const maxRetries = 3
        while (retryCount < maxRetries) {
          try {
            await startDownload(it.o_key, it.o_file_name)
            break
          } catch (err) {
            console.error('[migrate] Failed to download file:', it.o_key, it.o_file_name, err)
            updateFileItemStatus(file, it, { status: FileStatus.FAILED })
            throw err
          }
        }
      }
    }

    if (!hasFile(extractedPath)) {
      const primaryArchivePath = path.join(DOWNLOAD_DIR, primaryName)
      await start7zip({ mode: 'extract', archive: primaryArchivePath })
    }

    const compressedOut = await start7zip({ mode: 'compress', src: extractedPath })
    const outName = path.basename(compressedOut)

    const result = await uploadFile(compressedOut, outName, game_id, platform)

    if (hasFile(compressedOut)) deleteFile(compressedOut)
    for (const it of items) {
      const p = path.join(DOWNLOAD_DIR, it.o_file_name)
      if (hasFile(p)) deleteFile(p)
    }
    if (hasFile(extractedPath)) deleteFile(extractedPath)

    for (const it of items) {
      updateFileItemStatus(file, it, {
        status: FileStatus.COMPLETED,
        n_key: result.s3Key,
        n_file_name: result.file_name,
        n_file_size: result.file_size,
        n_file_hash: result.file_hash,
        n_file_content_type: result.file_content_type,
      })
    }
  } catch (err) {
    console.error('[migrate] Failed to process file group:', game_id, platform, err)
    for (const it of items) updateFileItemStatus(file, it, { status: FileStatus.FAILED })
    throw err
  }
}

const updateFileItemStatus = (file: File, target: FileItem, updates: Partial<FileItem>) => {
  for (const item of file.items) {
    if (item.o_key === target.o_key && item.game_id === target.game_id) {
      if (updates.status !== undefined) item.status = updates.status
      if (updates.n_key !== undefined) item.n_key = updates.n_key
      if (updates.n_file_name !== undefined) item.n_file_name = updates.n_file_name
      if (updates.n_file_size !== undefined) item.n_file_size = updates.n_file_size
      if (updates.n_file_hash !== undefined) item.n_file_hash = updates.n_file_hash
      if (updates.n_file_content_type !== undefined)
        item.n_file_content_type = updates.n_file_content_type
    }
  }
  updateItemInFinalFiles(
    (it) => it.o_key === target.o_key && it.game_id === target.game_id,
    (it) => {
      if (updates.status !== undefined) it.status = updates.status
      if (updates.n_key !== undefined) it.n_key = updates.n_key
      if (updates.n_file_name !== undefined) it.n_file_name = updates.n_file_name
      if (updates.n_file_size !== undefined) it.n_file_size = updates.n_file_size
      if (updates.n_file_hash !== undefined) it.n_file_hash = updates.n_file_hash
      if (updates.n_file_content_type !== undefined)
        it.n_file_content_type = updates.n_file_content_type
    },
  )
}

const main = async () => {
  const files = readFile<File[]>('final_files.json')!
  for (const file of files) {
    const isCompleted = file.items.every((item) => item.status === FileStatus.COMPLETED)
    if (isCompleted) {
      continue
    }
    await process(file)
  }
}

main()
