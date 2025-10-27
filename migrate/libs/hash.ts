import { createHash } from 'node:crypto'
import fs from 'node:fs'

const hash = async (path: string) => {
  const hash = createHash('sha256')
  const rs = fs.createReadStream(path)
  for await (const chunk of rs) hash.update(chunk as Buffer)
  const sha256 = hash.digest('hex')
  return sha256
}

export { hash }
