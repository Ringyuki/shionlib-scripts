import json from './files/converted_array.json' with { type: 'json' }

const data: Array<{ b_id: number; v_id: number | null }> = json
const token = process.env.TOKEN
const total_count = data.length
let succeed_count = 0
let failed_count = 0
let skipped_count = 0
let auth_error = false
const API_URL = process.env.API_URL!

const addGame = async (i: { b_id: number; v_id: number | null }) => {
  if (auth_error) {
    console.log('Auth error, skipping')
    return
  }
  if (!i.v_id) {
    skipped_count++
    console.log(`Skipped ${i.b_id} because v_id is null`)
    return
  }

  let res: { code: number; message: string; data: string }
  const doRequest = async () => {
    res = await fetch(`${API_URL}/api/game/create/frombv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        b_id: i.b_id,
        v_id: i.v_id,
      }),
    }).then((res) => res.json())
    if (res.message.includes('429')) {
      console.log(`Rate limited, waiting 60 second`)
      await new Promise((resolve) => setTimeout(resolve, 60000))
      return doRequest()
    }
  }
  await doRequest()

  if (res!.code !== 0) {
    if (res!.code === 400105) {
      skipped_count++
      console.log(`Skipped ${i.b_id} game already exists`)
      return
    } else if (res!.code === 200101) {
      auth_error = true
      return
    } else {
      failed_count++
      console.log(`Failed ${i.b_id} ${res!.message}`)
      return
    }
  }
  console.log(`Succeeded ${i.b_id} game id: ${res!.data}`)
  succeed_count++
}

const main = async () => {
  for (let i = 0; i < data.length; i++) {
    if (auth_error) {
      console.log('Auth error')
      console.log(`Total ${total_count} games`)
      console.log(`Succeeded ${succeed_count} games`)
      console.log(`Failed ${failed_count} games`)
      console.log(`Skipped ${skipped_count} games`)
      return
    }
    await addGame(data[i])
  }
  console.log(`Total ${total_count} games`)
  console.log(`Succeeded ${succeed_count} games`)
  console.log(`Failed ${failed_count} games`)
  console.log(`Skipped ${skipped_count} games`)
}

main()
