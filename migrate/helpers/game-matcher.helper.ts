import { Game } from '../interfaces/game.interface'
import { extractCjkBigrams, extractLatinTokens, hasCjk, normalize } from './text.helper'

export type GameIndex = {
  tokenToGameIds: Map<string, Set<number>>
  cjkBigramToGameIds: Map<string, Set<number>>
  gameIdToCandidates: Map<number, Set<string>>
}

const addToMap = (map: Map<string, Set<number>>, key: string, id: number) => {
  const set = map.get(key) || new Set<number>()
  set.add(id)
  map.set(key, set)
}

export const buildGameIndex = (games: Game[]): GameIndex => {
  const tokenToGameIds = new Map<string, Set<number>>()
  const cjkBigramToGameIds = new Map<string, Set<number>>()
  const gameIdToCandidates = new Map<number, Set<string>>()

  for (const g of games) {
    const candidates = [g.title_jp, g.title_en, g.title_zh, ...(g.aliases || [])]
      .filter(Boolean)
      .map((s) => normalize(s))
      .filter((s) => s.length > 0)

    const uniqueCandidates = Array.from(new Set(candidates))
    gameIdToCandidates.set(g.game_id, new Set(uniqueCandidates))

    for (const cand of uniqueCandidates) {
      const tokens = extractLatinTokens(cand)
      for (const t of tokens) addToMap(tokenToGameIds, t, g.game_id)

      if (hasCjk(cand)) {
        const bigrams = extractCjkBigrams(cand)
        for (const bg of bigrams) addToMap(cjkBigramToGameIds, bg, g.game_id)
      }
    }
  }

  return { tokenToGameIds, cjkBigramToGameIds, gameIdToCandidates }
}

export const chooseBestMatch = (filename: string, index: GameIndex): number | undefined => {
  const normName = normalize(filename)
  const tokens = extractLatinTokens(normName)
  const bigrams = extractCjkBigrams(normName)

  const score = new Map<number, number>()
  const inc = (id: number, w: number) => score.set(id, (score.get(id) || 0) + w)

  for (const t of tokens) {
    const ids = index.tokenToGameIds.get(t)
    if (!ids) continue
    for (const id of ids) inc(id, 1)
  }

  for (const bg of bigrams) {
    const ids = index.cjkBigramToGameIds.get(bg)
    if (!ids) continue
    for (const id of ids) inc(id, 2)
  }

  if (score.size === 0) return undefined

  let bestId: number | undefined
  let bestScore = -1
  for (const [id, s] of score.entries()) {
    if (s > bestScore) {
      bestScore = s
      bestId = id
    }
  }

  if (bestId == null) return undefined

  const candidates = index.gameIdToCandidates.get(bestId)
  if (!candidates) return undefined

  const nameNoSpace = normName.replace(/\s+/g, '')
  for (const cand of candidates) {
    if (cand.length === 0) continue
    if (normName.includes(cand)) return bestId
    const candNoSpace = cand.replace(/\s+/g, '')
    if (candNoSpace.length >= 3 && nameNoSpace.includes(candNoSpace)) return bestId
  }

  const hasCjkSignal = bigrams.length > 0 && bestScore >= 6
  const hasLatinSignal = tokens.length > 0 && bestScore >= 3
  return hasCjkSignal || hasLatinSignal ? bestId : undefined
}
