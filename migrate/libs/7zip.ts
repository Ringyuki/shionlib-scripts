import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { SingleBar, Presets } from 'cli-progress'
import {
  EXTRACTED_DIR as EXTRACT_DIR_BASE,
  COMPRESSED_DIR as OUTPUT_DIR_BASE,
} from '../constants/dirs'

const DEFAULT_FORMAT: '7z' | 'zip' = '7z'
const COMPRESSION_LEVEL = '1'
const CANDIDATE_BINS = [process.env.SEVEN_ZIP, '7zz', '7z', '7za'].filter(Boolean) as string[]
const EXTRACT_PASSWORD = process.env.UNZIP_PASSWORD

export type StartOptions =
  | { mode: 'extract'; archive: string; destDir?: string }
  | {
      mode: 'compress'
      src: string
      outPath?: string
      format?: '7z' | 'zip'
    }

const ensureDir = (p: string) => {
  fs.mkdirSync(p, { recursive: true })
}

const basenameNoExt = (p: string) => {
  const b = path.basename(p)
  return b.replace(/\.(7z|zip|tar|tgz|tar\.gz)$/i, '')
}

const resolve7zBinary = (): string => {
  for (const bin of CANDIDATE_BINS) {
    try {
      const r = spawnSync(bin, ['-h'], { stdio: 'ignore' })
      if (r.status === 0 || r.status === 1) return bin
    } catch {}
  }
  throw new Error(
    `7z executable not found. Please install 7-Zip (or 7zz) and ensure it is in PATH, or set the SEVEN_ZIP environment variable to point to the executable.`,
  )
}

const attachProgressParser = (child: ReturnType<typeof spawn>, label: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const bar = new SingleBar(
      { format: `${label} |{bar}| {percentage}% | {state}`, hideCursor: true },
      Presets.shades_classic,
    )
    bar.start(100, 0, { state: 'start' })

    let lastPct = 0
    let lastLine = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      lastLine = chunk.trim() || lastLine
      let m: RegExpExecArray | null
      const re = /(\d{1,3})%/g
      let localMax = lastPct
      while ((m = re.exec(chunk)) !== null) {
        const p = Math.max(0, Math.min(100, parseInt(m[1], 10)))
        if (p > localMax) localMax = p
      }
      if (localMax !== lastPct) {
        lastPct = localMax
        bar.update(lastPct, { state: lastLine || 'working' })
      }
    })

    let errBuf = ''
    let rejected = false
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => {
      errBuf += d
      if (rejected) return
      if (
        /wrong password|password is incorrect|can not open encrypted archive|data error in encrypted file/i.test(
          d,
        )
      ) {
        if (bar.isActive) bar.stop()
        rejected = true
        try {
          child.kill('SIGKILL')
        } catch {}
        return reject(new Error('Extract password error'))
      }
    })

    child.on('close', (code) => {
      if (lastPct < 100) bar.update(100)
      bar.stop()
      if (code === 0) return resolve()
      const msg = errBuf.trim() || `7z exit code ${code}`
      reject(new Error(msg))
    })
    child.on('error', (e) => {
      if (bar.isActive) bar.stop()
      reject(e)
    })
  })
}

const start = async (options: StartOptions): Promise<string> => {
  const bin = resolve7zBinary()

  if (options.mode === 'extract') {
    const { archive } = options
    if (!fs.existsSync(archive)) throw new Error(`Archive not found: ${archive}`)

    const name = basenameNoExt(archive)
    const dest = path.resolve(options.destDir ?? path.join(EXTRACT_DIR_BASE, name))
    ensureDir(dest)

    const args = [
      'x',
      archive,
      `-o${dest}`,
      '-y',
      '-bsp1',
      '-bso0',
      ...(EXTRACT_PASSWORD ? [`-p${EXTRACT_PASSWORD}`] : []),
    ]
    console.log(`[7z] Extract: ${archive}`)
    console.log(`     -> ${dest}`)

    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    await attachProgressParser(child, 'extract')
    console.log(`[7z] Extracted -> ${dest}`)
    return path.basename(dest)
  }

  // compress
  const { src } = options
  if (!fs.existsSync(src)) throw new Error(`Source path not found: ${src}`)

  const format = options.format ?? DEFAULT_FORMAT
  const base = path.basename(path.resolve(src))
  ensureDir(OUTPUT_DIR_BASE)

  const out = path.resolve(options.outPath ?? path.join(OUTPUT_DIR_BASE, `${base}.${format}`))

  const typeSwitch = format === 'zip' ? '-tzip' : '-t7z'
  const args = ['a', typeSwitch, `-mx=${COMPRESSION_LEVEL}`, out, src, '-bsp1', '-bso0']
  console.log(`[7z] Compress: ${src}`)
  console.log(`     -> ${out} (${format}, mx=${COMPRESSION_LEVEL})`)

  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  await attachProgressParser(child, 'compress')
  console.log(`[7z] Compressed -> ${out}`)
  return out
}

export { start }
