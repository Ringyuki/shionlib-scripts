export enum FileStatus {
  PENDING = 0,
  PROCESSING = 1,
  COMPLETED = 2,
  FAILED = 3,
}

export interface FileItem {
  o_key: string
  o_file_name: string

  n_key: string
  n_file_name: string
  n_file_size: number
  n_file_hash: string
  n_file_content_type: string

  game_id: number
  status: FileStatus
}

export interface File {
  items: FileItem[]
  platform: 'pc' | 'pe'
  game_id: number
}
