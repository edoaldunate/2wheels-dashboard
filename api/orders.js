/**
 * Vercel API Route — /api/orders
 * Variables de entorno en Vercel (una sola vez, nunca expiran):
 *   BOOQABLE_TOKEN     → Access Token de Booqable
 *   BOOQABLE_SUBDOMAIN → 2wheels-rental
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { BOOQABLE_TOKEN, BOOQABLE_SUBDOMAIN = '2wheels-rental' } = process.env
  if (!BOOQABLE_TOKEN) return res.status(500).json({ error: 'Falta BOOQABLE_TOKEN en Vercel env vars' })

  const { from, till, page = '1', size = '30' } = req.query

  const now = new Date()
  const fromISO = from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const tillISO = till || new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString()

  const p = new URLSearchParams()
  p.append('sort', '-number')
  p.append('filter[conditions][operator]', 'or')
  p.append('filter[conditions][attributes][][operator]', 'and')
  p.append('filter[conditions][attributes][][attributes][][starts_at][gte]', fromISO)
  p.append('filter[conditions][attributes][][attributes][][starts_at][lte]', tillISO)
  p.append('filter[conditions][attributes][][operator]', 'and')
  p.append('filter[conditions][attributes][][attributes][][stops_at][gte]', fromISO)
  p.append('filter[conditions][attributes][][attributes][][stops_at][lte]', tillISO)
  p.append('filter[statuses][not_eq][]', 'canceled')
  p.append('filter[statuses][not_eq][]', 'archived')
  p.append('filter[statuses][not_eq][]', 'new')
  p.append('stats[grand_total_in_cents][]', 'sum')
  p.append('stats[to_be_paid_in_cents][]', 'sum')
  p.append('stats[price_in_cents][]', 'sum')
  p.append('stats[item_count][]', 'sum')
  p.append('stats[total]', 'count')
  p.append('include', 'customer,lines')
  p.append('page[number]', page)
  p.append('page[size]', size)

  const url = `https://${BOOQABLE_SUBDOMAIN}.booqable.com/api/boomerang/orders?${p}`

  try {
    const r = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${BOOQABLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
    })

    if (r.status === 401 || r.status === 403) {
      return res.status(401).json({ error: 'Token inválido' })
    }
    if (!r.ok) return res.status(r.status).json({ error: `Booqable error ${r.status}` })

    const raw = await r.json()

    // La API boomerang devuelve JSON:API con data[] e included[]
    // Normalizamos a un formato simple para el frontend
    const included = raw.included || []

    const orders = (raw.data || []).map(item => {
      const a = item.attributes || {}
      const custRel = item.relationships?.customer?.data
      const custObj = custRel ? included.find(i => i.type === 'customers' && i.id === custRel.id) : null
      // Resolver lines (productos) desde included
      const lineRels = item.relationships?.lines?.data || []
      const lines = lineRels
        .map(rel => included.find(i => i.type === 'lines' && i.id === rel.id))
        .filter(Boolean)
        .map(l => ({
          title:    l.attributes?.title || '—',
          quantity: l.attributes?.quantity || 1,
        }))

      return {
        id:                   item.id,
        number:               a.number,
        status:               a.status,
        payment_status:       a.payment_status,
        customer_name:        custObj?.attributes?.name || '—',
        starts_at:            a.starts_at,
        stops_at:             a.stops_at,
        item_count:           a.item_count,
        price_in_cents:       a.price_in_cents       || 0,
        grand_total_in_cents: a.grand_total_in_cents  || 0,
        to_be_paid_in_cents:  a.to_be_paid_in_cents   || 0,
        lines,
      }
    })

    const meta = raw.meta || {}

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate')
    return res.status(200).json({ orders, meta })

  } catch (err) {
    console.error('[orders]', err)
    return res.status(500).json({ error: err.message })
  }
}
