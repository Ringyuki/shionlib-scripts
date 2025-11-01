import { start as startDownload } from './libs/download'
import { start as start7zip } from './libs/7zip'
import {
  readFile,
  deleteFile,
  hasFile,
  updateItemInFinalFiles,
  selectPrimary,
  isMultipart as isMultipartFile,
} from './utils/file'
import { File, FileItem } from './interfaces/file.interface'
import path from 'path'
import { uploadFile } from './libs/upload'
import { stripArchiveSuffix } from './helpers/text.helper'
import { DOWNLOAD_DIR, EXTRACTED_DIR, COMPRESSED_DIR } from './constants/dirs'
import { FileStatus } from './interfaces/file.interface'

const processMigrate = async (file: File) => {
  const { items, platform, game_id } = file
  if (!items.length) return
  if (
    items.every((it) => it.status === FileStatus.SKIPPED) &&
    process.env.PROCESS_SKIPPED !== 'true'
  )
    return

  const firstName = items[0].o_file_name
  const extractedName = stripArchiveSuffix(firstName)
  const extractedPath = path.join(EXTRACTED_DIR, extractedName)

  const names = items.map((i) => i.o_file_name)
  const primaryName = selectPrimary(names)
  const isMultipart = isMultipartFile(names)
  if (isMultipart && items.length === 0) {
    for (const it of items)
      updateFileItemStatus(file, it, {
        status: FileStatus.SKIPPED,
        skipped_reason: 'Multipart file but no parts found',
      })
    return
  }

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
          } catch (err: any) {
            if (err?.code === 'URL_CHECK_FAILED') {
              const reason = err?.reason ?? err?.message ?? 'URL check failed'
              const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason)
              console.warn(
                '[migrate] Skip item due to URL check:',
                it.o_key,
                it.o_file_name,
                reasonStr,
              )
              updateFileItemStatus(file, it, {
                status: FileStatus.SKIPPED,
                skipped_reason: reasonStr,
              })
              break
            }
            console.error('[migrate] Failed to download file:', it.o_key, it.o_file_name, err)
            updateFileItemStatus(file, it, { status: FileStatus.FAILED })
            throw err
          }
        }
      }
    }

    const allSkipped = items.every((it) => it.status === FileStatus.SKIPPED)
    if (allSkipped) {
      console.warn('[migrate] Skip group (all items skipped):', game_id, platform)
      for (const it of items) {
        console.warn('  -', it.o_file_name, it.skipped_reason || 'unknown')
      }
      return
    }

    const primaryArchivePath = path.join(DOWNLOAD_DIR, primaryName)

    if (isMultipart) {
      // Guard: missing first volume (e.g. .7z.001 / .part1.rar / .rar / .z01)
      const hasFirstVolume = names.some(
        (n) =>
          /\.part0*1\.rar$/i.test(n) ||
          /\.(7z|zip)\.0*1$/i.test(n) ||
          /\.rar$/i.test(n) ||
          /\.z0*1$/i.test(n),
      )
      if (!hasFirstVolume) {
        for (const it of items) {
          if (it.status !== FileStatus.SKIPPED)
            updateFileItemStatus(file, it, {
              status: FileStatus.SKIPPED,
              skipped_reason: 'Multipart first volume missing',
            })
        }
        console.warn('[migrate] Skip group (multipart missing first volume):', game_id, platform)
        return
      }

      // Guard: only-first-volume case (e.g. only .001 or only .part1.rar with no subsequent parts)
      const hasSubsequentVolume = names.some(
        (n) =>
          /\.(7z|zip)\.0*2$/i.test(n) || // .002 for 7z/zip
          /\.part0*2\.rar$/i.test(n) || // .part2.rar
          /\.[rz]0*1$/i.test(n), // .r01 or .z01
      )
      if (!hasSubsequentVolume) {
        for (const it of items) {
          if (it.status !== FileStatus.SKIPPED)
            updateFileItemStatus(file, it, {
              status: FileStatus.SKIPPED,
              skipped_reason: 'Multipart subsequent volume missing (only first volume present)',
            })
        }
        console.warn('[migrate] Skip group (multipart only first volume):', game_id, platform)
        return
      }

      const allPartsExist = items.every((it) => hasFile(path.join(DOWNLOAD_DIR, it.o_file_name)))
      if (!allPartsExist) {
        for (const it of items) {
          if (!hasFile(path.join(DOWNLOAD_DIR, it.o_file_name))) {
            if (it.status !== FileStatus.SKIPPED)
              updateFileItemStatus(file, it, {
                status: FileStatus.SKIPPED,
                skipped_reason: 'Multipart incomplete after download',
              })
          }
        }
        console.warn('[migrate] Skip group (multipart incomplete):', game_id, platform)
        for (const it of items) {
          const exists = hasFile(path.join(DOWNLOAD_DIR, it.o_file_name))
          if (!exists)
            console.warn('  - missing', it.o_file_name, it.skipped_reason || 'missing part')
        }
        return
      }
    } else {
      if (!hasFile(primaryArchivePath)) {
        const it0 = items[0]
        if (it0 && it0.status !== FileStatus.SKIPPED)
          updateFileItemStatus(file, it0, {
            status: FileStatus.SKIPPED,
            skipped_reason: 'Primary archive missing after download',
          })
        console.warn(
          '[migrate] Skip group (primary archive missing):',
          game_id,
          platform,
          primaryName,
        )
        return
      }
    }

    if (!hasFile(extractedPath)) {
      try {
        await start7zip({ mode: 'extract', archive: primaryArchivePath })
      } catch (e: any) {
        const msg = String(e?.message || e)
        if (/Extract password error/i.test(msg)) {
          console.warn('[migrate] Skip group (extract password error):', game_id, platform)
          for (const it of items) {
            if (it.status !== FileStatus.SKIPPED)
              updateFileItemStatus(file, it, {
                status: FileStatus.SKIPPED,
                skipped_reason: 'Extract password error',
              })
          }
          if (hasFile(extractedPath)) deleteFile(extractedPath)
          return
        }
        throw e
      }
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
      if (updates.skipped_reason !== undefined) item.skipped_reason = updates.skipped_reason
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
      if (updates.skipped_reason !== undefined) it.skipped_reason = updates.skipped_reason
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
    await processMigrate(file)
  }
}

main()
