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

const ensureDirSync = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

const getUrl = async (key: string): Promise<string> => {
  const res = await fetch(`${BUCKET1_URL}/${key}`)
  if (!res.ok) {
    return `${BUCKET2_URL}${key}`
  }
  return `${BUCKET1_URL}${key}`
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

const start = async (key: string, outName: string): Promise<boolean> => {
  ensureDirSync(DOWNLOAD_DIR)
  const url = await getUrl(key)
  if (!url) {
    console.error(`[aria2] Failed to get URL for key: ${key}`)
    return false
  }

  const savePath = path.join(DOWNLOAD_DIR, outName)
  console.log(`[aria2] Start download`)
  console.log(`  URL : ${url}`)
  console.log(`  Save: ${savePath}`)

  const gid = await addDownload(url, { dir: DOWNLOAD_DIR, out: outName })

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

      if (st === 'complete') {
        bar.update(total, {
          speed: '0 B',
          state: 'complete',
          done: formatBytes(total),
          total: formatBytes(total),
        })
        bar.stop()
        console.log(`[aria2] Done: ${savePath}`)
        return true
      }
      if (st === 'error' || st === 'removed') {
        bar.stop()
        const msg = s.errorMessage ? ` - ${s.errorMessage}` : ''
        console.error(`Download ${st}${msg}`)
        await debugDumpOnError(gid, url, savePath, key)
        return false
      }
      await new Promise((r) => setTimeout(r, pollInterval))
    }
  } catch (err) {
    if (bar.isActive) bar.stop()
    console.error(err)
    try {
      await debugDumpOnError(gid, url, savePath, key)
    } catch {}
    return false
  }
}

export { start }
