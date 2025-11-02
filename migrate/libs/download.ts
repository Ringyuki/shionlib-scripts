import http from 'http'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { SingleBar, Presets } from 'cli-progress'
import { DOWNLOAD_DIR } from '../constants/dirs'

const BUCKET1_URL = process.env.BUCKET1_URL!
const BUCKET2_URL = process.env.BUCKET2_URL!

const ARIA2_HOST = '127.0.0.1'
const ARIA2_PORT = 6800
const ARIA2_SECRET = process.env.ARIA2_SECRET!

const SPLIT = 16 // --split
const MPS = 16 // --max-connection-per-server
const MIN_SPLIT = '1M' // --min-split-size

type Aria2TellStatus = {
  status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed'
  completedLength?: string
  totalLength?: string
  downloadSpeed?: string
  errorCode?: string
  errorMessage?: string
}

const formatBytes = (n: number): string => {
  if (!Number.isFinite(n)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

const rpcCall = async <T = any>(method: string, params: any[] = []): Promise<T> => {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params: ['token:' + ARIA2_SECRET, ...params],
  })

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: ARIA2_HOST,
        port: ARIA2_PORT,
        method: 'POST',
        path: '/jsonrpc',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let chunks = ''
        res.setEncoding('utf8')
        res.on('data', (d) => (chunks += d))
        res.on('end', () => {
          try {
            const json = JSON.parse(chunks)
            if (json.error) {
              const err = new Error(`aria2 RPC error ${json.error.code}: ${json.error.message}`)
              // @ts-ignore
              err.code = json.error.code
              return reject(err)
            }
            resolve(json as T)
          } catch (e) {
            reject(e)
          }
        })
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

const addDownload = async (
  url: string,
  {
    dir,
    out,
    split = SPLIT,
    mps = MPS,
    minSplit = MIN_SPLIT,
  }: {
    dir: string
    out: string
    split?: number
    mps?: number
    minSplit?: string
  },
): Promise<string> => {
  const opts: Record<string, string> = {
    dir,
    out,
    split: String(split),
    'max-connection-per-server': String(mps),
    'min-split-size': minSplit,
    continue: 'true',
    'auto-file-renaming': 'false',
    'allow-overwrite': 'true',
    'retry-wait': '2',
    'max-tries': '8',
  }
  const r: any = await rpcCall('aria2.addUri', [[url], opts])
  return r.result as string // gid
}

const tellStatus = async (gid: string): Promise<Aria2TellStatus> => {
  const keys = [
    'status',
    'completedLength',
    'totalLength',
    'downloadSpeed',
    'errorCode',
    'errorMessage',
  ]
  const r: any = await rpcCall('aria2.tellStatus', [gid, keys])
  return r.result as Aria2TellStatus
}

// Try to find an existing aria2 task that is already downloading to savePath
const findExistingTaskByPath = async (
  savePath: string,
): Promise<{ gid: string; status: string } | null> => {
  try {
    const [active, waiting] = await Promise.all([
      rpcCall<any>('aria2.tellActive').catch(() => ({ result: [] })),
      rpcCall<any>('aria2.tellWaiting', [0, 1000]).catch(() => ({ result: [] })),
    ])

    const lists: any[] = [...(active.result || []), ...(waiting.result || [])]
    for (const it of lists) {
      const files = it.files || []
      for (const f of files) {
        if (f.path === savePath) {
          return { gid: it.gid, status: it.status }
        }
      }
    }
  } catch {}
  return null
}

const forceStopAndCleanup = async (gid: string) => {
  try {
    await rpcCall('aria2.forcePause', [gid]).catch(() => null)
    await rpcCall('aria2.forceRemove', [gid]).catch(() => null)
  } catch {}
  try {
    await rpcCall('aria2.removeDownloadResult', [gid]).catch(() => null)
  } catch {}
}

const softRecoverFromStall = async (gid: string): Promise<boolean> => {
  try {
    await rpcCall('aria2.forcePause', [gid])
    await new Promise((r) => setTimeout(r, 300))
    await rpcCall('aria2.unpause', [gid])
    return true
  } catch {
    return false
  }
}

const ensureDirSync = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

const getUrl = async (key: string): Promise<string> => {
  while (true) {
    try {
      const res = await fetch(`${BUCKET1_URL}/${key}`, { method: 'HEAD' })
      if (res.status === 429) {
        console.warn('[aria2] BUCKET1 HEAD 429, waiting 60s and retrying BUCKET1...')
        await new Promise((r) => setTimeout(r, 60000))
        continue
      }
      if (res.ok) return `${BUCKET1_URL}${key}`
      // non-429, non-ok: fallback to BUCKET2
      return `${BUCKET2_URL}${key}`
    } catch {
      // network error while checking BUCKET1: fallback to BUCKET2
      return `${BUCKET2_URL}${key}`
    }
  }
}

const checkUrl = async (url: string): Promise<{ ok: boolean; data?: any }> => {
  while (true) {
    try {
      const res = await fetch(url, { method: 'HEAD' })
      // If rate limited, wait and retry forever
      if (res.status === 429) {
        console.warn(`[aria2] HEAD 429 received, waiting 60s and retrying...`)
        await new Promise((r) => setTimeout(r, 60000))
        continue
      }
      if (res.ok) return { ok: true }
      let data: any = null
      try {
        data = await res.json()
      } catch {
        data = { status: res.status, statusText: res.statusText }
      }
      return { ok: false, data }
    } catch (e) {
      throw e
    }
  }
}

class SkipDownloadError extends Error {
  code = 'URL_CHECK_FAILED'
  reason?: any
  constructor(message: string, reason?: any) {
    super(message)
    this.name = 'SkipDownloadError'
    this.reason = reason
  }
}

/** ===================================================== */
const debugDumpOnError = async (gid: string, url: string, savePath: string, key: string) => {
  console.error('\n[aria2][debug] ===== ERROR DIAGNOSTICS BEGIN =====')

  try {
    const [st, files, servers, gstat, ver] = await Promise.all([
      rpcCall<any>('aria2.tellStatus', [gid]).catch((e) => ({ error: String(e) })),
      rpcCall<any>('aria2.getFiles', [gid]).catch(() => null),
      rpcCall<any>('aria2.getServers', [gid]).catch(() => null),
      rpcCall<any>('aria2.getGlobalStat').catch(() => null),
      rpcCall<any>('aria2.getVersion').catch(() => null),
    ])
    console.error('[aria2][debug] URL     :', url)
    console.error('[aria2][debug] Save    :', savePath)
    console.error('[aria2][debug] key     :', key)
    console.error('[aria2][debug] tellStatus:', JSON.stringify(st?.result ?? st, null, 2))
    if (files) console.error('[aria2][debug] getFiles  :', JSON.stringify(files.result, null, 2))
    if (servers)
      console.error('[aria2][debug] getServers:', JSON.stringify(servers.result, null, 2))
    if (gstat) console.error('[aria2][debug] globalStat:', JSON.stringify(gstat.result, null, 2))
    if (ver) console.error('[aria2][debug] version   :', JSON.stringify(ver.result, null, 2))
  } catch (e) {
    console.error('[aria2][debug] failed to collect aria2 diagnostics:', e)
  }

  try {
    const h = await fetch(url, { method: 'HEAD' })
    console.error('[aria2][debug] HEAD     :', h.status, h.statusText)
    const keys = [
      'content-length',
      'accept-ranges',
      'content-type',
      'server',
      'via',
      'date',
      'cf-cache-status',
    ]
    const hdr: Record<string, string> = {}
    for (const k of keys) {
      const v = h.headers.get(k)
      if (v) hdr[k] = v
    }
    console.error('[aria2][debug] HEAD hdr :', hdr)
  } catch (e) {
    console.error('[aria2][debug] HEAD failed:', e)
  }

  try {
    const df = spawnSync('df', ['-Pk', savePath], { encoding: 'utf8' })
    if (df.status === 0) {
      console.error('[aria2][debug] df -Pk  :\n' + df.stdout.trim())
    } else {
      console.error('[aria2][debug] df error:', df.stderr?.trim() || df.status)
    }
  } catch (e) {}

  console.error('[aria2][debug] ====== ERROR DIAGNOSTICS END ======\n')
}
/** ===================================================== */

type StartOptions = {
  retries?: number
  backoffMs?: number // base backoff in ms (exponential)
  stallTimeoutMs?: number // no progress for this long => treat as stall
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const verifyFileIntegrity = (savePath: string, expectedSize?: number): void => {
  if (!fs.existsSync(savePath)) {
    throw new Error(`Downloaded file missing: ${savePath}`)
  }
  try {
    const st = fs.statSync(savePath)
    if (expectedSize && expectedSize > 0 && st.size !== expectedSize) {
      throw new Error(`Size mismatch: got ${st.size}, expected ${expectedSize}`)
    }
    if (st.size <= 0) {
      throw new Error(`Downloaded file is empty: ${savePath}`)
    }
  } catch (e) {
    throw e
  }
}

const prepareTargetForDownload = (savePath: string) => {
  const ctrlPath = `${savePath}.aria2`
  const fileExists = fs.existsSync(savePath)
  const ctrlExists = fs.existsSync(ctrlPath)

  // If file exists but aria2 control file is missing, remove the stale file to avoid aria2 abort
  if (fileExists && !ctrlExists) {
    try {
      fs.unlinkSync(savePath)
      console.warn(`[aria2] Removed existing file without control: ${savePath}`)
    } catch (e) {
      throw new Error(`Failed to remove existing file before download: ${savePath} - ${e}`)
    }
  }

  // If control file exists but data file is missing, remove stale control file
  if (!fileExists && ctrlExists) {
    try {
      fs.unlinkSync(ctrlPath)
      console.warn(`[aria2] Removed stale control file without data: ${ctrlPath}`)
    } catch (e) {
      throw new Error(`Failed to remove stale control file: ${ctrlPath} - ${e}`)
    }
  }
}

const downloadOnce = async (
  key: string,
  outName: string,
  opts: Required<StartOptions>,
): Promise<void> => {
  ensureDirSync(DOWNLOAD_DIR)
  const url = await getUrl(key)
  if (!url) {
    console.error(`[aria2] Failed to get URL for key: ${key}`)
    throw new Error('Failed to get URL')
  }

  const savePath = path.join(DOWNLOAD_DIR, outName)
  console.log(`[aria2] Start download`)
  console.log(`  URL : ${url}`)
  console.log(`  Save: ${savePath}`)

  // Try reuse existing task if any
  let gid: string
  const existing = await findExistingTaskByPath(savePath)
  if (existing) {
    gid = existing.gid
  } else {
    try {
      const { ok, data } = await checkUrl(url)
      if (!ok) {
        throw new SkipDownloadError('URL HEAD check failed', data)
      }
    } catch (e: any) {
      if (e instanceof SkipDownloadError || e?.code === 'URL_CHECK_FAILED') {
        throw e
      }
      throw new SkipDownloadError('URL HEAD request error', { error: String(e?.message || e) })
    }
    // Only cleanup local target when no active/waiting task holds it
    prepareTargetForDownload(savePath)
    gid = await addDownload(url, { dir: DOWNLOAD_DIR, out: outName })
  }

  const bar = new SingleBar(
    {
      format: '{name} |{bar}| {percentage}% | {done}/{total} | {speed}/s | {state}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    },
    Presets.shades_classic,
  )

  let total = 1
  bar.start(total, 0, {
    name: outName,
    speed: '0 B',
    state: 'init',
    done: '0 B',
    total: 'unknown',
  })

  const pollInterval = 500
  let lastProgressBytes = 0
  let lastProgressAt = Date.now()
  let stallSoftRetries = 0
  try {
    while (true) {
      const s = await tellStatus(gid)
      const doneBytes = Number(s.completedLength || '0')
      const totalBytes = Number(s.totalLength || '0')
      const speed = Number(s.downloadSpeed || '0')
      const st = s.status

      if (totalBytes > 0 && total !== totalBytes) {
        total = totalBytes
        typeof (bar as any).setTotal === 'function' ? (bar as any).setTotal(total) : null
      }
      bar.update(Math.min(doneBytes, total), {
        speed: formatBytes(speed),
        state: st,
        done: formatBytes(doneBytes),
        total: totalBytes > 0 ? formatBytes(totalBytes) : 'unknown',
      })

      if (doneBytes > lastProgressBytes) {
        lastProgressBytes = doneBytes
        lastProgressAt = Date.now()
      } else {
        const now = Date.now()
        if (now - lastProgressAt > opts.stallTimeoutMs) {
          // soft recover first
          if (stallSoftRetries < 2) {
            stallSoftRetries++
            bar.update(Math.min(doneBytes, total), {
              speed: formatBytes(speed),
              state: `stall-recover-${stallSoftRetries}`,
              done: formatBytes(doneBytes),
              total: totalBytes > 0 ? formatBytes(totalBytes) : 'unknown',
            })
            await softRecoverFromStall(gid)
            lastProgressAt = Date.now()
          } else {
            throw new Error(`Download stalled for ${(opts.stallTimeoutMs / 1000).toFixed(0)}s`)
          }
        }
      }

      if (st === 'complete') {
        bar.update(total, {
          speed: '0 B',
          state: 'complete',
          done: formatBytes(total),
          total: formatBytes(total),
        })
        bar.stop()
        console.log(`[aria2] Done: ${savePath}`)
        verifyFileIntegrity(savePath, totalBytes > 0 ? totalBytes : undefined)
        try {
          await rpcCall('aria2.removeDownloadResult', [gid])
        } catch {}
        return
      }
      if (st === 'error' || st === 'removed') {
        bar.stop()
        const msg = s.errorMessage ? ` - ${s.errorMessage}` : ''
        console.error(`Download ${st}${msg}`)
        await debugDumpOnError(gid, url, savePath, key)
        try {
          await forceStopAndCleanup(gid)
        } catch {}
        throw new Error(`aria2 status: ${st}${msg}`)
      }
      await new Promise((r) => setTimeout(r, pollInterval))
    }
  } catch (err) {
    if (bar.isActive) bar.stop()
    console.error(err)
    try {
      await debugDumpOnError(gid, url, savePath, key)
    } catch {}
    try {
      await forceStopAndCleanup(gid)
    } catch {}
    throw err
  }
}

const start = async (
  key: string,
  outName: string,
  options: StartOptions = {},
): Promise<boolean> => {
  const retries = options.retries ?? 3
  const backoffMs = options.backoffMs ?? 60000
  const stallTimeoutMs = options.stallTimeoutMs ?? 1200000

  const opts: Required<StartOptions> = { retries, backoffMs, stallTimeoutMs }

  let attempt = 0
  while (attempt < retries) {
    attempt++
    try {
      await downloadOnce(key, outName, opts)
      return true
    } catch (e) {
      // @ts-ignore
      if (e?.code === 'URL_CHECK_FAILED') {
        throw e
      }
      if (attempt >= retries) {
        throw e
      }
      // Before retrying, ensure no active task is still holding the file
      try {
        const savePath = path.join(DOWNLOAD_DIR, outName)
        const existing = await findExistingTaskByPath(savePath)
        if (existing) {
          await forceStopAndCleanup(existing.gid)
        }
      } catch {}
      const delay = backoffMs * Math.pow(2, attempt - 1)
      console.warn(`[aria2] attempt ${attempt} failed, retrying in ${Math.round(delay / 1000)}s...`)
      await sleep(delay)
    }
  }
  throw new Error('Download failed after retries')
}

export { start }
