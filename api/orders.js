/**
 * Vercel API Route — /api/orders
 * Proxy seguro hacia Booqable. Las credenciales viven en variables de entorno
 * de Vercel, nunca expuestas en el frontend.
 *
 * Variables de entorno requeridas en Vercel:
 *   BOOQABLE_SESSION   → valor de la cookie _booqable_session
 *   BOOQABLE_CSRF      → valor del header x-csrf-token
 *   BOOQABLE_PUSHER    → valor del header x-booqable-pusher-session-id
 *   BOOQABLE_SUBDOMAIN → ej: 2wheels-rental
 */

export default async function handler(req, res) {
  // CORS — permite llamadas desde cualquier origen (GitHub Pages, local, etc.)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const {
    BOOQABLE_SESSION,
    BOOQABLE_CSRF,
    BOOQABLE_PUSHER,
    BOOQABLE_SUBDOMAIN = '2wheels-rental',
  } = process.env

  if (!BOOQABLE_SESSION || !BOOQABLE_CSRF) {
    return res.status(500).json({ error: 'Credenciales no configuradas en Vercel env vars' })
  }

  // Parámetros que llegan del frontend
  const {
    from   = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
    till   = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59).toISOString(),
    page   = '1',
    size   = '30',
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
        'accept': 'application/json, text/plain, */*',
        'cookie': `_booqable_session=${BOOQABLE_SESSION}`,
        'x-csrf-token': BOOQABLE_CSRF,
        'x-booqable-pusher-session-id': BOOQABLE_PUSHER || '',
        'user-agent': 'Mozilla/5.0 (compatible; 2wheels-dashboard/1.0)',
      },
    })

    if (response.status === 401 || response.status === 403) {
      return res.status(401).json({ error: 'Sesión expirada — actualiza BOOQABLE_SESSION en Vercel' })
    }

    if (!response.ok) {
      return res.status(response.status).json({ error: `Booqable respondió ${response.status}` })
    }

    const data = await response.json()
    // Cache 60 segundos en Vercel Edge
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate')
    return res.status(200).json(data)

  } catch (err) {
    console.error('[orders proxy]', err)
    return res.status(500).json({ error: err.message })
  }
}
