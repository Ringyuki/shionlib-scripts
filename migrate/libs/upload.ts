import { s3 } from './s3'
import { hash } from './hash'
import mime from 'mime-types'
import fs from 'node:fs'
import { SingleBar, Presets } from 'cli-progress'

const API_URL = process.env.API_URL!
const token = process.env.TOKEN!
const client = s3()

interface CreateDownloadResourceParams {
  game_id: number
  platform: 'pc' | 'pe'
}
interface CreateDownloadResourceFileParams {
  resource_id: number
  file_name: string
  file_size: number
  file_hash: string
  file_content_type: string
  s3_file_key: string
}

const createDownloadResource = async ({ game_id, platform }: CreateDownloadResourceParams) => {
  console.log('[upload] Creating download resource for game_id:', game_id, 'platform:', platform)
  const res = await fetch(`${API_URL}/api/migrate/game-download-resource/${game_id}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      platform: platform === 'pc' ? ['win'] : ['and'],
      language: ['zh'],
    }),
  }).then((res) => res.json())
  if (res.code !== 0) {
    console.error(res)
    throw new Error(`Failed to create download resource: ${res.code} ${res.message}`)
  }
  console.log('[upload] Download resource created:', res.data)
  return res.data as number
}

const createDownloadResourceFile = async ({
  resource_id,
  file_name,
  file_size,
  file_hash,
  file_content_type,
  s3_file_key,
}: CreateDownloadResourceFileParams) => {
  console.log(
    '[upload] Creating download resource file for resource_id:',
    resource_id,
    'file_name:',
    file_name,
  )
  const res = await fetch(`${API_URL}/api/migrate/game-download-resource/file/${resource_id}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      file_name,
      file_size,
      file_hash,
      file_content_type,
      s3_file_key,
    }),
  }).then((res) => res.json())
  if (res.code !== 0) {
    console.error(res)
    throw new Error(`Failed to create download resource file: ${res.code} ${res.message}`)
  }
  console.log('[upload] Download resource file created.')
}

interface UploadResult {
  s3Key: string
  file_name: string
  file_size: number
  file_hash: string
  file_content_type: string
}

const uploadFile = async (
  path: string,
  file_name: string,
  game_id: number,
  platform: 'pc' | 'pe',
): Promise<UploadResult> => {
  console.log('[upload] Uploading file:', path, file_name, game_id, platform)
  console.log('[upload] Hashing file:', path)
  const file_hash = await hash(path)
  const file_content_type = mime.lookup(path) || ''
  const file_size = fs.statSync(path).size

  const resource_id = await createDownloadResource({ game_id, platform })

  const stream = fs.createReadStream(path)
  const s3Key = `games/${game_id}/${resource_id}/${file_name}`
  console.log('[upload] Uploading file to S3:', s3Key)
  const bar = new SingleBar(
    {
      format: `${file_name} |{bar}| {percentage}% | {value}/{total} bytes`,
      hideCursor: true,
    },
    Presets.shades_classic,
  )
  bar.start(file_size, 0)
  try {
    await client.uploadFileStream(
      s3Key,
      stream,
      file_content_type,
      game_id,
      file_hash,
      (uploaded, total) => {
        const t = typeof total === 'number' ? total : file_size
        const v = Math.min(uploaded, t)
        bar.setTotal(t)
        bar.update(v)
      },
    )
  } finally {
    bar.stop()
  }
  console.log('[upload] File uploaded to S3.')

  await createDownloadResourceFile({
    resource_id,
    file_name,
    file_size,
    file_hash,
    file_content_type,
    s3_file_key: s3Key,
  })
  return { s3Key, file_name, file_size, file_hash, file_content_type }
}

export { createDownloadResource, createDownloadResourceFile, uploadFile }
