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
  for (const item of items) {
    const { o_key, o_file_name } = item
    const archivePath = path.join(DOWNLOAD_DIR, o_file_name)
    const extractedName = stripExt(o_file_name, { all: true })
    const extractedPath = path.join(EXTRACTED_DIR, extractedName)
    const compressedPath = path.join(COMPRESSED_DIR, o_file_name)

    try {
      updateFileItemStatus(file, item, { status: FileStatus.PROCESSING })

      const isDownloaded = hasFile(archivePath)
      const isExtracted = hasFile(extractedPath)
      const isCompressed = hasFile(compressedPath)

      if (!isCompressed) {
        if (!isExtracted) {
          if (!isDownloaded) {
            await startDownload(o_key, o_file_name)
          }
          await start7zip({ mode: 'extract', archive: archivePath })
        }
        await start7zip({ mode: 'compress', src: extractedPath })
      }

      const result = await uploadFile(compressedPath, o_file_name, game_id, platform)
      if (hasFile(compressedPath)) deleteFile(compressedPath)
      if (hasFile(archivePath)) deleteFile(archivePath)
      if (hasFile(extractedPath)) deleteFile(extractedPath)

      updateFileItemStatus(file, item, {
        status: FileStatus.COMPLETED,
        n_key: result.s3Key,
        n_file_name: result.file_name,
        n_file_size: result.file_size,
        n_file_hash: result.file_hash,
        n_file_content_type: result.file_content_type,
      })
    } catch (err) {
      console.error('[migrate] Failed to process file item:', item.o_key, item.game_id)
      updateFileItemStatus(file, item, { status: FileStatus.FAILED })
      throw err
    }
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
