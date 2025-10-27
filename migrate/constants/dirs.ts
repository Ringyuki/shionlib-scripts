import path from 'path'
import { cwd } from 'process'

export const DOWNLOAD_DIR = path.resolve(cwd(), 'migrate/downloads')
export const EXTRACTED_DIR = path.resolve(cwd(), 'migrate/extracted')
export const COMPRESSED_DIR = path.resolve(cwd(), 'migrate/archives')
