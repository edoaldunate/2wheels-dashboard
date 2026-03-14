/**
 * Vercel API Route — /api/orders
 * Trae TODAS las páginas server-side con delay entre llamadas
 * y retry automático ante 429 (rate limit de Booqable).
 *
 * Variables de entorno en Vercel:
 *   BOOQABLE_TOKEN     → Access Token permanente
 *   BOOQABLE_SUBDOMAIN → 2wheels-rental
 */

const PAGE_SIZE   = 25          // tamaño de página — más pequeño = menos 429
const PAGE_DELAY  = 350         // ms entre páginas para no saturar Booqable
const RETRY_DELAY = 2000        // ms de espera ante un 429 antes de reintentar
const MAX_RETRIES = 3           // intentos máximos por request

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, options)
    if (res.status === 429) {
      // Respetar el header Retry-After si viene, si no usar RETRY_DELAY
      const retryAfter = res.headers.get('Retry-After')
      const wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : RETRY_DELAY * attempt
      if (attempt < retries) {
        await sleep(wait)
        continue
      }
    }
    return res
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { BOOQABLE_TOKEN, BOOQABLE_SUBDOMAIN = '2wheels-rental' } = process.env
  if (!BOOQABLE_TOKEN) return res.status(500).json({ error: 'Falta BOOQABLE_TOKEN' })

  const now = new Date()
  const { from, till } = req.query
  const fromISO = from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const tillISO = till || new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString()

  const headers = {
    'Authorization': `Bearer ${BOOQABLE_TOKEN}`,
    'Content-Type': 'application/json',
  }
  const base = `https://${BOOQABLE_SUBDOMAIN}.booqable.com/api/boomerang`

  try {
    // ── 1. Traer TODAS las páginas de órdenes ─────────────────────────────
    const allOrderItems = []
    const allIncluded   = []
    let currentPage = 1
    let totalCount  = Infinity
    let firstMeta   = null

    while (allOrderItems.length < totalCount) {
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
      p.append('page[number]', String(currentPage))
      p.append('page[size]', String(PAGE_SIZE))

      const ordersRes = await fetchWithRetry(`${base}/orders?${p}`, { headers })

      if (ordersRes.status === 401 || ordersRes.status === 403) {
        return res.status(401).json({ error: 'Token inválido' })
      }
      if (ordersRes.status === 429) {
        return res.status(429).json({ error: 'Booqable rate limit — intentá con un rango de fechas más acotado' })
      }
      if (!ordersRes.ok) {
        return res.status(ordersRes.status).json({ error: `Booqable error ${ordersRes.status}` })
      }

      const raw = await ordersRes.json()
      const pageItems    = raw.data     || []
      const pageIncluded = raw.included || []

      if (currentPage === 1) {
        firstMeta  = raw.meta || {}
        totalCount = firstMeta?.stats?.total?.count ?? pageItems.length
      }

      allOrderItems.push(...pageItems)
      allIncluded.push(...pageIncluded)

      if (pageItems.length < PAGE_SIZE) break   // última página
      currentPage++

      // Delay cortés entre páginas para no saturar Booqable
      if (allOrderItems.length < totalCount) await sleep(PAGE_DELAY)
    }

    // ── 2. Traer lines (en lotes de 25 órdenes para evitar 429) ──────────
    const linesMap = {}

    for (let i = 0; i < allOrderItems.length; i += PAGE_SIZE) {
      const batch   = allOrderItems.slice(i, i + PAGE_SIZE)
      const batchIds = batch.map(o => o.id)

      const lp = new URLSearchParams()
      batchIds.forEach(id => lp.append('filter[order_id][]', id))
      lp.append('fields[lines]', 'title,quantity,order_id,price_in_cents')
      lp.append('include', 'owner')
      lp.append('fields[product_groups]', 'id')
      lp.append('page[size]', '200')

      const linesRes = await fetchWithRetry(`${base}/lines?${lp}`, { headers })
      if (linesRes && linesRes.ok) {
        const linesRaw = await linesRes.json()
        for (const line of (linesRaw.data || [])) {
          const a   = line.attributes || {}
          const oid = a.order_id
          if (!oid) continue
          if (!linesMap[oid]) linesMap[oid] = []
          if (a.title) {
            const ownerRel = line.relationships?.owner?.data
            const ownerId = ownerRel ? ownerRel.id : null
            linesMap[oid].push({ title: a.title, quantity: a.quantity || 1, owner_id: ownerId })
          }
        }
      }

      // Delay entre lotes de lines
      if (i + PAGE_SIZE < allOrderItems.length) await sleep(PAGE_DELAY)
    }

    // ── 3. Traer collections y mapear sus product_groups via filter ──────────
    const pgCollections = {}  // productGroupId → string[]
    try {
      // 1. Obtener lista de collections
      const collRes = await fetchWithRetry(
        `${base}/collections?fields[collections]=id,name&page[size]=100`,
        { headers }
      )
      if (collRes && collRes.ok) {
        const collRaw = await collRes.json()
        const collections = (collRaw.data || [])
          .map(c => ({ id: c.id, name: c.attributes?.name }))
          .filter(c => c.name && c.name !== 'All')

        // 2. Para cada collection, traer sus product_groups via filter
        for (const coll of collections) {
          const pgRes = await fetchWithRetry(
            `${base}/product_groups?filter[collection_id]=${coll.id}&fields[product_groups]=id&page[size]=100`,
            { headers }
          )
          if (pgRes && pgRes.ok) {
            const pgRaw = await pgRes.json()
            for (const pg of (pgRaw.data || [])) {
              if (!pgCollections[pg.id]) pgCollections[pg.id] = []
              if (!pgCollections[pg.id].includes(coll.name)) pgCollections[pg.id].push(coll.name)
            }
          }
          await sleep(PAGE_DELAY)
        }
      }
    } catch(_) { /* no bloquea si falla */ }

    // ── 4. Normalizar y devolver ──────────────────────────────────────────
    // Deduplicar included (puede haber customers repetidos entre páginas)
    const includedMap = {}
    for (const inc of allIncluded) {
      includedMap[`${inc.type}:${inc.id}`] = inc
    }
    const included = Object.values(includedMap)

    const orders = allOrderItems.map(item => {
      const a       = item.attributes || {}
      const custRel = item.relationships?.customer?.data
      const custObj = custRel ? included.find(i => i.type === 'customers' && i.id === custRel.id) : null
      const ca      = custObj?.attributes || {}

      return {
        id:                   item.id,
        number:               a.number,
        status:               a.status,
        payment_status:       a.payment_status,
        customer_name:        ca.name       || '—',
        customer_email:       ca.email      || null,
        customer_phone:       ca.phone      || null,
        customer_address1:    ca.address1   || null,
        customer_address2:    ca.address2   || null,
        customer_city:        ca.city       || null,
        customer_region:      ca.region     || null,
        customer_zipcode:     ca.zipcode    || null,
        customer_country:     ca.country    || null,
        customer_notes:       ca.notes      || null,
        customer_id:          custObj?.id   || null,
        starts_at:            a.starts_at,
        stops_at:             a.stops_at,
        item_count:           a.item_count,
        price_in_cents:       a.price_in_cents       || 0,
        grand_total_in_cents: a.grand_total_in_cents  || 0,
        to_be_paid_in_cents:  a.to_be_paid_in_cents   || 0,
        lines:                (linesMap[item.id] || []).map(l => ({
          ...l,
          collections: pgCollections[l.owner_id] || []
        })),
      }
    })

    // Cache más largo para rangos grandes (reduce re-fetches)
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60')
    return res.status(200).json({ orders, meta: firstMeta || {} })

  } catch (err) {
    console.error('[orders]', err)
    return res.status(500).json({ error: err.message })
  }
}
