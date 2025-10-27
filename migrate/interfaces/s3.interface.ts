export interface S3Object {
  Key: string
  LastModified: Date
  ETag: string
  Size: number
  StorageClass: string

  speculative_game_id?: number
  platform?: 'pc' | 'pe'
}

const map = new Map<number, S3Object>()
