/**
 * Vercel API Route — /api/orders
 * Proxy hacia Booqable usando Access Token permanente.
 *
 * Variables de entorno en Vercel (se configuran una sola vez, nunca expiran):
 *   BOOQABLE_TOKEN     → Access Token de Booqable
 *   BOOQABLE_SUBDOMAIN → 2wheels-rental
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const {
    BOOQABLE_TOKEN,
    BOOQABLE_SUBDOMAIN = '2wheels-rental',
  } = process.env

  if (!BOOQABLE_TOKEN) {
    return res.status(500).json({ error: 'Falta BOOQABLE_TOKEN en las variables de entorno de Vercel' })
  }

  const {
    from = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
    till = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59).toISOString(),
    page = '1',
    size = '30',
  } = req.query

  const p = new URLSearchParams()
  p.append('sort', '-number')
  p.append('filter[conditions][operator]', 'or')
  p.append('filter[conditions][attributes][][operator]', 'and')
  p.append('filter[conditions][attributes][][attributes][][starts_at][gte]', from)
  p.append('filter[conditions][attributes][][attributes][][starts_at][lte]', till)
  p.append('filter[conditions][attributes][][operator]', 'and')
  p.append('filter[conditions][attributes][][attributes][][stops_at][gte]', from)
  p.append('filter[conditions][attributes][][attributes][][stops_at][lte]', till)
  p.append('filter[statuses][not_eq][]', 'canceled')
  p.append('filter[statuses][not_eq][]', 'archived')
  p.append('filter[statuses][not_eq][]', 'new')
  p.append('stats[grand_total_in_cents][]', 'sum')
  p.append('stats[to_be_paid_in_cents][]', 'sum')
  p.append('stats[price_in_cents][]', 'sum')
  p.append('stats[item_count][]', 'sum')
  p.append('stats[total]', 'count')
  p.append('include', 'customer,start_location,stop_location')
  p.append('page[number]', page)
  p.append('page[size]', size)

  const booqableURL = `https://${BOOQABLE_SUBDOMAIN}.booqable.com/api/boomerang/orders?${p}`

  try {
    const response = await fetch(booqableURL, {
      headers: {
        'Authorization': `Bearer ${BOOQABLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
    })

    if (response.status === 401 || response.status === 403) {
      return res.status(401).json({ error: 'Token inválido — revisa BOOQABLE_TOKEN en Vercel' })
    }

    if (!response.ok) {
      return res.status(response.status).json({ error: `Booqable respondió ${response.status}` })
    }

    const data = await response.json()
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate')
    return res.status(200).json(data)

  } catch (err) {
    console.error('[orders proxy]', err)
    return res.status(500).json({ error: err.message })
  }
}
