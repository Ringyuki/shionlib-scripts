import { S3Client, paginateListObjectsV2 } from '@aws-sdk/client-s3'
import { S3Object } from '../interfaces/s3.interface'
import { Upload } from '@aws-sdk/lib-storage'
import { Readable } from 'node:stream'

const region = process.env.AWS_REGION!
const endpoint = 'https://s3.us-east-005.backblazeb2.com'
const accessKeyId = process.env.AWS_ACCESS_KEY_ID!
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY!
const bucket = process.env.BUCKET!

export const s3 = () => {
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error('AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY must be set')
  }
  const client = new S3Client({
    region,
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })

  const getFileList = async (bucket: string) => {
    let list: S3Object[] = []
    const page = paginateListObjectsV2(
      {
        client,
        pageSize: 1000,
      },
      {
        Bucket: bucket,
      },
    )
    for await (const p of page) {
      for (const o of p.Contents ?? []) {
        if (!o.Key || !o.LastModified || !o.ETag || !o.Size || !o.StorageClass) {
          continue
        }
        list.push({
          Key: o.Key,
          LastModified: o.LastModified,
          ETag: o.ETag,
          Size: o.Size,
          StorageClass: o.StorageClass,
        })
      }
    }
    return list
  }

  const uploadFileStream = async (
    key: string,
    stream: Readable,
    content_type: string,
    game_id: number,
    file_hash: string,
    onProgress?: (uploadedBytes: number, totalBytes?: number) => void,
  ) => {
    const uploader = new Upload({
      client: client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: stream,
        ContentType: content_type,
        Metadata: {
          'game-id': game_id.toString(),
          'uploader-id': 'migrate',
          scan: 'ok',
          'file-sha256': file_hash,
        },
      },
      queueSize: 4,
      partSize: 1024 * 1024 * 32,
      leavePartsOnError: false,
    })
    if (onProgress) {
      uploader.on('httpUploadProgress', (evt: any) => {
        if (typeof evt?.loaded === 'number') {
          onProgress(evt.loaded, evt.total)
        }
      })
    }
    return uploader.done()
  }

  return {
    getFileList,
    uploadFileStream,
  }
}
