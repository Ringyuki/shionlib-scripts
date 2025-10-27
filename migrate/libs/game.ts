import { Game } from '../interfaces/game.interface'

const token = process.env.TOKEN
const API_URL = process.env.API_URL!

const getGames = async (): Promise<Game[]> => {
  const data = await fetch(`${API_URL}/api/game/migrate/all`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  }).then(async (res) => {
    const data = await res.json()
    if (data.code !== 0) {
      console.error(data)
      throw new Error(`Failed to get games: ${data.code} ${data.message}`)
    }
    return data.data
  })

  return data as Game[]
}

export { getGames }
