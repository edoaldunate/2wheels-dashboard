/**
 * Vercel API Route — /api/orders
 * Variables de entorno en Vercel:
 *   BOOQABLE_TOKEN     → Access Token permanente
 *   BOOQABLE_SUBDOMAIN → 2wheels-rental
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { BOOQABLE_TOKEN, BOOQABLE_SUBDOMAIN = '2wheels-rental' } = process.env
  if (!BOOQABLE_TOKEN) return res.status(500).json({ error: 'Falta BOOQABLE_TOKEN' })

  const now = new Date()
  const { from, till, page = '1', size = '30' } = req.query
  const fromISO = from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const tillISO = till || new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString()

  const headers = {
    'Authorization': `Bearer ${BOOQABLE_TOKEN}`,
    'Content-Type': 'application/json',
  }
  const base = `https://${BOOQABLE_SUBDOMAIN}.booqable.com/api/boomerang`

  try {
    // ── 1. Traer órdenes ──────────────────────────────────────────────────
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
    p.append('include', 'customer')
    p.append('page[number]', page)
    p.append('page[size]', size)

    const ordersRes = await fetch(`${base}/orders?${p}`, { headers })
    if (ordersRes.status === 401 || ordersRes.status === 403) {
      return res.status(401).json({ error: 'Token inválido' })
    }
    if (!ordersRes.ok) return res.status(ordersRes.status).json({ error: `Booqable error ${ordersRes.status}` })

    const raw = await ordersRes.json()
    const included = raw.included || []
    const orderItems = raw.data || []

    // IDs de las órdenes para buscar sus lines
    const orderIds = orderItems.map(o => o.id)

    // ── 2. Traer lines de todas las órdenes en una sola llamada ───────────
    let linesMap = {} // { order_id: [{title, quantity}] }

    if (orderIds.length > 0) {
      const lp = new URLSearchParams()
      // Filtrar lines que pertenezcan a cualquiera de estas órdenes
      orderIds.forEach(id => lp.append('filter[order_id][]', id))
      lp.append('fields[lines]', 'title,quantity,order_id,price_in_cents')
      lp.append('page[size]', '100')

      const linesRes = await fetch(`${base}/lines?${lp}`, { headers })
      if (linesRes.ok) {
        const linesRaw = await linesRes.json()
        for (const line of (linesRaw.data || [])) {
          const a = line.attributes || {}
          const oid = a.order_id
          if (!oid) continue
          if (!linesMap[oid]) linesMap[oid] = []
          // Solo incluir lines que son productos (tienen título, no son líneas de descuento etc)
          if (a.title) {
            linesMap[oid].push({
              title:    a.title,
              quantity: a.quantity || 1,
            })
          }
        }
      }
    }

    // ── 3. Normalizar y devolver ──────────────────────────────────────────
    const orders = orderItems.map(item => {
      const a = item.attributes || {}
      const custRel = item.relationships?.customer?.data
      const custObj = custRel ? included.find(i => i.type === 'customers' && i.id === custRel.id) : null

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
        lines:                linesMap[item.id]       || [],
      }
    })

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate')
    return res.status(200).json({ orders, meta: raw.meta || {} })

  } catch (err) {
    console.error('[orders]', err)
    return res.status(500).json({ error: err.message })
  }
}
