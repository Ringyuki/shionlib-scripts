import { s3 } from './libs/s3'
import { S3Object } from './interfaces/s3.interface'
import { saveFile, readFile } from './utils/file'
import { Game } from './interfaces/game.interface'
import { getGames } from './libs/game'
import { parseFilePath } from './helpers/parse-file-path.helper'
import { buildGameIndex, chooseBestMatch } from './helpers/game-matcher.helper'
import { parse } from 'path'
import { archiveGroupKey } from './helpers/text.helper'
import { File, FileItem, FileStatus } from './interfaces/file.interface'

const s3Client = s3()

const create_raw_files = async (): Promise<S3Object[]> => {
  if (readFile<S3Object[]>('raw_files.json')) {
    return readFile<S3Object[]>('raw_files.json')!
  }
  let raw_files: S3Object[] = []
  raw_files.push(...(await s3Client.getFileList('hikari-games')))
  raw_files.push(...(await s3Client.getFileList('hikari-games-authors')))

  const SUFFIX_RE = /\.(?:zip|rar|7z)(?:\.\d+)?$|\.(?:part\d+|r\d{2}|z\d{2}|\d{3,})$/i
  raw_files = raw_files.filter((r) => SUFFIX_RE.test(r.Key))
  saveFile(raw_files, 'raw_files.json')
  return raw_files
}

const create_games = async (): Promise<Game[]> => {
  if (readFile<Game[]>('games.json')) {
    return readFile<Game[]>('games.json')!
  }
  const games = await getGames()
  saveFile(games, 'games.json')
  return games
}

const create_raw_files_with_game_id = async (): Promise<S3Object[]> => {
  const games = await create_games()
  const index = buildGameIndex(games)
  let raw_files = readFile<S3Object[]>('raw_files.json')!
  raw_files = raw_files.map((f) => {
    const { file_name } = parseFilePath(f.Key)
    const matchedId = chooseBestMatch(file_name, index)
    if (matchedId != null) {
      f.speculative_game_id = matchedId
    }
    return f
  })
  saveFile(raw_files, 'raw_files_with_game_id.json')
  return raw_files
}

const filter_raw_files_with_game_id = async (): Promise<S3Object[]> => {
  let raw_files = readFile<S3Object[]>('raw_files_with_game_id.json')!
  raw_files = raw_files.filter((f) => f.speculative_game_id != undefined)
  saveFile(raw_files, 'raw_files_with_game_id_filtered.json')
  return raw_files
}

const add_platform_to_raw_files = async (): Promise<S3Object[]> => {
  let raw_files = readFile<S3Object[]>('raw_files_with_game_id_filtered.json')!
  raw_files = raw_files.map((f) => {
    const { folders } = parseFilePath(f.Key)
    const platform = folders.includes('PE') ? 'pe' : 'pc'
    f.platform = platform
    return f
  })
  saveFile(raw_files, 'raw_files_with_platform.json')
  return raw_files
}

const make_final_files = async () => {
  let raw_files = readFile<S3Object[]>('raw_files_with_platform.json')!

  const items: FileItem[] = raw_files.map((rf) => {
    const { base } = parse(rf.Key)
    const o_file_name = base || ''
    const game_id = rf.speculative_game_id!

    const item: FileItem = {
      o_key: rf.Key,
      o_file_name,
      n_key: '',
      n_file_name: '',
      n_file_size: 0,
      n_file_hash: '',
      n_file_content_type: '',
      game_id,
      status: FileStatus.PENDING,
    }
    return item
  })

  const groupMap = new Map<string, File>()
  for (let i = 0; i < raw_files.length; i++) {
    const rf = raw_files[i]
    const platform = rf.platform as 'pc' | 'pe'
    const game_id = rf.speculative_game_id!
    const { base } = parse(rf.Key)
    const groupName = archiveGroupKey(base || '')
    const key = `${game_id}__${platform}__${groupName}`
    if (!groupMap.has(key)) {
      groupMap.set(key, { platform, game_id, items: [] })
    }
    groupMap.get(key)!.items.push(items[i])
  }

  const files: File[] = Array.from(groupMap.values()).map((g) => ({
    items: g.items,
    platform: g.platform,
    game_id: g.game_id,
  }))

  saveFile(files, 'final_files.json')
}

const main = async () => {
  await create_raw_files()
  await create_games()
  await create_raw_files_with_game_id()
  await filter_raw_files_with_game_id()
  await add_platform_to_raw_files()
  await make_final_files()
}

main()
