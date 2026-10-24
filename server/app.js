import express from 'express'
import { randomUUID } from 'node:crypto'
import { calculateZone, createDatabase } from './db.js'

const transitions = {
  ASSIGNED: { from: 'NEW' },
  DISPATCHED: { from: 'ASSIGNED' },
  COMPLETED: { from: 'DISPATCHED' },
  CANCELLED: { from: ['NEW', 'ASSIGNED', 'DISPATCHED'] },
}

export function createApp({ db = createDatabase(), allowDemoReset = process.env.NODE_ENV !== 'production', corsOrigins } = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cache-Control', 'no-store')
    req.requestId = randomUUID()
    res.setHeader('X-Request-Id', req.requestId)
    next()
  })
  const configuredOrigins = corsOrigins ?? process.env.CORS_ORIGIN
  const origins = new Set((Array.isArray(configuredOrigins)
    ? configuredOrigins
    : typeof configuredOrigins === 'string'
      ? configuredOrigins.split(',')
      : process.env.NODE_ENV === 'production'
        ? []
        : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5176', 'http://127.0.0.1:5176'])
    .map(origin => origin.trim()).filter(Boolean))

  app.use((req, res, next) => {
    const origin = req.get('Origin')
    if (origin) {
      if (!origins.has(origin)) return res.status(403).json({ error: 'This browser origin is not allowed by the API CORS policy.' })
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Max-Age', '600')
      return res.status(204).end()
    }
    next()
  })
  app.use(express.json({ limit: '32kb', strict: true }))

  const zoneStatement = db.prepare('SELECT id,name,lat,lng,fill,growth,base_load FROM zones WHERE id = ?')
  const findZone = id => {
    const row = zoneStatement.get(id)
    return row && calculateZone({ ...row, baseLoad: row.base_load })
  }
  const requestRow = db.prepare('SELECT * FROM requests WHERE id = ?')
  const requestEvents = db.prepare('SELECT status,at,detail FROM request_events WHERE request_id = ? ORDER BY id')
  const serializeRequest = row => {
    if (!row) return null
    return {
      id: row.id,
      zoneId: row.zone_id,
      zone: row.zone_name,
      fill: row.fill,
      risk: row.risk,
      category: row.category,
      eta: row.eta,
      load: row.load,
      reason: row.reason,
      action: row.action,
      status: row.status,
      vehicleId: row.vehicle_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      events: requestEvents.all(row.id).map(event => ({ status: event.status, at: event.at, ...(event.detail ? { detail: event.detail } : {}) })),
    }
  }
  const now = () => new Date().toISOString()
  const addEvent = db.prepare('INSERT INTO request_events (request_id,status,at,detail) VALUES (?,?,?,?)')
  const updateStatus = db.prepare('UPDATE requests SET status = ?, vehicle_id = ?, updated_at = ? WHERE id = ?')
  const inTransaction = fn => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  app.get('/api/health', (_req, res, next) => {
    try { db.prepare('SELECT 1').get(); res.json({ status: 'ok', storage: 'sqlite', database: 'available', syntheticData: true }) }
    catch (error) { next(error) }
  })

  app.get('/api/zones', (_req, res) => {
    const rows = db.prepare('SELECT id,name,lat,lng,fill,growth,base_load FROM zones ORDER BY rowid').all()
    res.json(rows.map(row => calculateZone({ ...row, baseLoad: row.base_load })))
  })

  app.get('/api/vehicles', (_req, res) => {
    res.json(db.prepare(`SELECT v.id,v.name,v.capacity,r.id AS assignedRequestId,r.status AS assignmentStatus
      FROM vehicles v LEFT JOIN requests r ON r.vehicle_id=v.id AND r.status IN ('ASSIGNED','DISPATCHED')
      ORDER BY v.id`).all().map(vehicle => ({ ...vehicle, available: vehicle.assignedRequestId === null })))
  })

  app.get('/api/requests', (_req, res) => {
    const rows = db.prepare('SELECT * FROM requests ORDER BY created_at DESC, rowid DESC').all()
    res.json(rows.map(serializeRequest))
  })

  app.post('/api/requests', (req, res, next) => {
    try {
      const zoneId = typeof req.body?.zoneId === 'string' ? req.body.zoneId.trim() : ''
      const zone = zoneId && findZone(zoneId)
      if (!zone) return res.status(400).json({ error: 'Choose a valid synthetic zone before creating a request.' })
      let fill = zone.fill
      if (req.body?.fill !== undefined) {
        if (typeof req.body.fill !== 'number' || !Number.isFinite(req.body.fill) || req.body.fill < 0 || req.body.fill > 100) {
          return res.status(400).json({ error: 'Fill level must be a number from 0 to 100.' })
        }
        fill = req.body.fill
      }
      const current = calculateZone(zone, fill)
      const createdAt = now()
      let id
      do { id = `EC-${createdAt.slice(0, 4)}-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}` }
      while (requestRow.get(id))
      const reason = current.explanation
      inTransaction(() => {
        db.prepare(`INSERT INTO requests
          (id,zone_id,zone_name,fill,risk,category,eta,load,reason,action,status,vehicle_id,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?, 'NEW', NULL, ?,?)`).run(
          id, current.id, current.name, current.fill, current.risk, current.category, current.eta,
          current.load, reason, current.action, createdAt, createdAt,
        )
        addEvent.run(id, 'NEW', createdAt, 'Collection request created in the EcoPulse demo.')
      })
      res.status(201).json(serializeRequest(requestRow.get(id)))
    } catch (error) { next(error) }
  })

  function changeStatus(req, res, next, status) {
    try {
      const { id } = req.params
      const row = requestRow.get(id)
      if (!row) return res.status(404).json({ error: 'Collection request was not found.' })
      const rule = transitions[status]
      if (!rule || !(Array.isArray(rule.from) ? rule.from.includes(row.status) : row.status === rule.from)) {
        return res.status(409).json({ error: `Cannot change request from ${row.status} to ${status}.` })
      }

      const vehicleId = status === 'ASSIGNED' ? req.body?.vehicleId : row.vehicle_id
      if (status === 'ASSIGNED') {
        if (typeof vehicleId !== 'string' || !db.prepare('SELECT id FROM vehicles WHERE id = ?').get(vehicleId)) {
          return res.status(400).json({ error: 'Select a valid demo vehicle to assign.' })
        }
      }

      const at = now()
      inTransaction(() => {
        const latest = requestRow.get(id)
        if (!latest || latest.status !== row.status) throw Object.assign(new Error('Request changed. Refresh and try again.'), { status: 409 })
        if (status === 'ASSIGNED') {
          const inUse = db.prepare("SELECT id FROM requests WHERE vehicle_id = ? AND status IN ('ASSIGNED','DISPATCHED') AND id <> ? LIMIT 1").get(vehicleId, id)
          if (inUse) throw Object.assign(new Error('That vehicle is already assigned to another active request.'), { status: 409 })
        }
        updateStatus.run(status, status === 'ASSIGNED' ? vehicleId : status === 'CANCELLED' || status === 'COMPLETED' ? null : latest.vehicle_id, at, id)
        addEvent.run(id, status, at, status === 'ASSIGNED' ? `Assigned to ${vehicleId}.` : `Request ${status.toLowerCase()}.`)
      })
      res.json(serializeRequest(requestRow.get(id)))
    } catch (error) { next(error) }
  }

  app.post('/api/requests/:id/assign', (req, res, next) => changeStatus(req, res, next, 'ASSIGNED'))
  app.post('/api/requests/:id/dispatch', (req, res, next) => changeStatus(req, res, next, 'DISPATCHED'))
  app.post('/api/requests/:id/complete', (req, res, next) => changeStatus(req, res, next, 'COMPLETED'))
  app.post('/api/requests/:id/cancel', (req, res, next) => changeStatus(req, res, next, 'CANCELLED'))

  app.get('/api/audit/events', (req, res, next) => {
    try {
      const { limit: rawLimit = '50', offset: rawOffset = '0', status: rawStatus } = req.query
      if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit)) || Number(rawLimit) < 1 || Number(rawLimit) > 100) {
        return res.status(400).json({ error: 'limit must be an integer from 1 to 100.', requestId: req.requestId })
      }
      if (typeof rawOffset !== 'string' || !/^\d+$/.test(rawOffset) || !Number.isSafeInteger(Number(rawOffset)) || Number(rawOffset) > 10000) {
        return res.status(400).json({ error: 'offset must be an integer from 0 to 10000.', requestId: req.requestId })
      }
      if (rawStatus !== undefined && typeof rawStatus !== 'string') {
        return res.status(400).json({ error: 'status must be a single supported request event status.', requestId: req.requestId })
      }
      const status = rawStatus === undefined ? null : rawStatus.toUpperCase()
      const allowedStatuses = new Set(['NEW', 'ASSIGNED', 'DISPATCHED', 'COMPLETED', 'CANCELLED', 'NOTIFIED'])
      if (status !== null && !allowedStatuses.has(status)) {
        return res.status(400).json({ error: 'status must be NEW, ASSIGNED, DISPATCHED, COMPLETED, CANCELLED or NOTIFIED.', requestId: req.requestId })
      }
      const limit = Number(rawLimit)
      const offset = Number(rawOffset)
      const rows = status
        ? db.prepare(`SELECT e.id AS eventId,e.request_id AS requestId,e.status AS eventType,e.status,e.at,e.detail,
            r.zone_id AS zoneId,r.zone_name AS zone,r.vehicle_id AS vehicleId
            FROM request_events e JOIN requests r ON r.id=e.request_id
            WHERE e.status=? ORDER BY e.id DESC LIMIT ? OFFSET ?`).all(status, limit, offset)
        : db.prepare(`SELECT e.id AS eventId,e.request_id AS requestId,e.status AS eventType,e.status,e.at,e.detail,
            r.zone_id AS zoneId,r.zone_name AS zone,r.vehicle_id AS vehicleId
            FROM request_events e JOIN requests r ON r.id=e.request_id
            ORDER BY e.id DESC LIMIT ? OFFSET ?`).all(limit, offset)
      const total = status
        ? db.prepare('SELECT COUNT(*) AS count FROM request_events WHERE status=?').get(status).count
        : db.prepare('SELECT COUNT(*) AS count FROM request_events').get().count
      res.json({
        generatedAt: now(),
        dataMode: 'SYNTHETIC_DEMO',
        disclaimer: 'Audit entries describe actions recorded in this prototype; they are not evidence of real municipal operations.',
        pagination: { limit, offset, total, hasMore: offset + rows.length < total },
        events: rows,
      })
    } catch (error) { next(error) }
  })

  app.get('/api/notifications', (_req, res) => {
    res.json(db.prepare('SELECT id,request_id,zone_id,zone_name,at,type,simulated FROM notifications ORDER BY at DESC,rowid DESC LIMIT 50').all().map(row => ({
      id: row.id, requestId: row.request_id, zoneId: row.zone_id, zone: row.zone_name,
      at: row.at, type: row.type, simulated: Boolean(row.simulated),
    })))
  })

  app.post('/api/notifications/simulate', (req, res, next) => {
    try {
      const body = req.body ?? {}
      if (typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'The request body must be a JSON object.', requestId: req.requestId })
      }
      const suppliedId = body.requestId
      if (suppliedId !== undefined && suppliedId !== null && (typeof suppliedId !== 'string' || !suppliedId.trim() || suppliedId.length > 128)) {
        return res.status(400).json({ error: 'requestId must be a valid collection request identifier.', requestId: req.requestId })
      }
      const row = suppliedId
        ? requestRow.get(suppliedId.trim())
        : db.prepare("SELECT * FROM requests WHERE status IN ('NEW','ASSIGNED','DISPATCHED') ORDER BY created_at DESC LIMIT 1").get()
      if (suppliedId && !row) return res.status(404).json({ error: 'Collection request was not found.' })
      const suppliedZoneId = body.zoneId
      if (suppliedZoneId !== undefined && suppliedZoneId !== null && (typeof suppliedZoneId !== 'string' || !suppliedZoneId.trim() || suppliedZoneId.length > 64)) {
        return res.status(400).json({ error: 'zoneId must be a valid synthetic zone identifier.', requestId: req.requestId })
      }
      const suppliedZone = suppliedZoneId ? findZone(suppliedZoneId.trim()) : null
      if (suppliedZoneId && !suppliedZone) return res.status(400).json({ error: 'Choose a valid synthetic zone.', requestId: req.requestId })
      const id = `EV-${randomUUID().slice(0, 12).toUpperCase()}`
      const at = now()
      const zoneId = row?.zone_id || suppliedZone?.id || null
      const zoneName = row?.zone_name || suppliedZone?.name || null
      inTransaction(() => {
        db.prepare('INSERT INTO notifications (id,request_id,zone_id,zone_name,at,type,simulated) VALUES (?,?,?,?,?,?,1)')
          .run(id, row?.id || null, zoneId, zoneName, at, 'MUNICIPAL_NOTIFICATION')
        if (row) addEvent.run(row.id, 'NOTIFIED', at, 'Simulated in-app event only; no SMS or email was sent.')
      })
      res.status(201).json({ id, requestId: row?.id || null, zoneId, zone: zoneName, at, type: 'MUNICIPAL_NOTIFICATION', simulated: true, message: 'In-app simulation only. No external message was sent.' })
    } catch (error) { next(error) }
  })

  app.post('/api/demo/reset', (req, res, next) => {
    try {
      const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      if (!allowDemoReset || !loopback) return res.status(403).json({ error: 'Demo reset is available only to a local development server.' })
      if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirm the local demo reset to delete saved request and notification history.' })
      inTransaction(() => {
        db.exec('DELETE FROM notifications; DELETE FROM request_events; DELETE FROM requests;')
      })
      res.json({ reset: true, message: 'Local demo request and notification history cleared.' })
    } catch (error) { next(error) }
  })

  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint was not found.', requestId: req.requestId }))
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return
    const status = Number.isInteger(error.status) ? error.status : error.type === 'entity.parse.failed' ? 400 : 500
    if (status >= 500) console.error(error)
    res.status(status).json({
      error: status >= 500 ? 'The server could not complete the request.' : error.type === 'entity.parse.failed' ? 'Invalid JSON request body.' : error.message,
      requestId: _req.requestId,
    })
  })
  app.locals.db = db
  return app
}
