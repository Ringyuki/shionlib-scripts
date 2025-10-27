export const FULLWIDTH_START = 65281
export const FULLWIDTH_END = 65374
export const FULLWIDTH_OFFSET = 65248

export const toHalfWidth = (input: string): string => {
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (code === 12288) {
      out += String.fromCharCode(32)
    } else if (code >= FULLWIDTH_START && code <= FULLWIDTH_END) {
      out += String.fromCharCode(code - FULLWIDTH_OFFSET)
    } else {
      out += input[i]
    }
  }
  return out
}

export const stripArchiveSuffix = (name: string): string => {
  return name
    .replace(/\.(zip|rar|7z)(?:\.[0-9]+)?$/i, '')
    .replace(/\.(part[0-9]+|r[0-9]{2}|z[0-9]{2}|[0-9]{3,})$/i, '')
}

export const normalize = (input: string): string => {
  const half = toHalfWidth(input).toLowerCase()
  const noExt = stripArchiveSuffix(half)
  const noBrackets = noExt.replace(/[\[\]{}()]/g, ' ')
  const separated = noBrackets.replace(/[._\-]+/g, ' ')
  return separated.replace(/\s+/g, ' ').trim()
}

export const hasCjk = (s: string): boolean =>
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/.test(s)

export const extractLatinTokens = (s: string): string[] => {
  const tokens = (s.match(/[a-z0-9]+/g) || []).filter((t) => t.length >= 2)
  return Array.from(new Set(tokens))
}

export const extractCjkBigrams = (s: string): string[] => {
  const chars = Array.from(s).filter((ch) =>
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/.test(ch),
  )
  const bigrams: string[] = []
  for (let i = 0; i < chars.length - 1; i++) {
    bigrams.push(chars[i] + chars[i + 1])
  }
  return Array.from(new Set(bigrams))
}

// Build a grouping key for multi-part archives: unify variations like .7z.001 / .part1.rar / .r00
export const archiveGroupKey = (fileName: string): string => {
  const lower = toHalfWidth(fileName).toLowerCase()
  // common patterns: name.7z.001 | name.part1.rar | name.r00 | name.z01
  const patterns = [
    /\.(7z|zip|rar)\.[0-9]{3,}$/i, // .7z.001, .zip.002
    /\.part[0-9]+\.(7z|zip|rar)$/i, // .part1.rar
    /\.[rz][0-9]{2}$/i, // .r00 .z01
  ]
  for (const re of patterns) {
    if (re.test(lower)) {
      return lower.replace(re, '.$1') // keep the main container ext as canonical
    }
  }
  return lower
}
