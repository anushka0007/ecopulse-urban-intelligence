import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'
import { createDatabase } from './db.js'

async function withApi(run, appOptions = {}) {
  const db = createDatabase(':memory:')
  const app = createApp({ db, ...appOptions })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try { await run(base) } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    db.close()
  }
}

const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('health and synthetic zones are available', async () => withApi(async base => {
  const health = await fetch(`${base}/api/health`).then(r => r.json())
  const zones = await fetch(`${base}/api/zones`).then(r => r.json())
  assert.equal(health.status, 'ok')
  assert.equal(health.database, 'available')
  assert.equal(health.syntheticData, true)
  assert.equal(zones.length, 12)
}))

test('CORS permits configured frontend origins and rejects other origins', async () => withApi(async base => {
  const allowedOrigin = 'https://ecopulse-frontend-3s6c.onrender.com'
  const allowed = await fetch(`${base}/api/health`, { headers: { Origin: allowedOrigin } })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.headers.get('access-control-allow-origin'), allowedOrigin)
  const preflight = await fetch(`${base}/api/requests`, { method: 'OPTIONS', headers: { Origin: allowedOrigin } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), allowedOrigin)
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET,POST,OPTIONS')
  const rejected = await fetch(`${base}/api/health`, { headers: { Origin: 'https://untrusted.example' } })
  assert.equal(rejected.status, 403)
}, { corsOrigins: ['  https://ecopulse-frontend-3s6c.onrender.com/  '] }))

test('CORS reads and normalizes the deployed frontend origin from the environment', async () => {
  const previousOrigin = process.env.CORS_ORIGIN
  process.env.CORS_ORIGIN = 'https://ecopulse-frontend-3s6c.onrender.com/'
  try {
    await withApi(async base => {
      const response = await fetch(`${base}/api/health`, { headers: { Origin: 'https://ecopulse-frontend-3s6c.onrender.com' } })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://ecopulse-frontend-3s6c.onrender.com')
    })
  } finally {
    if (previousOrigin === undefined) delete process.env.CORS_ORIGIN
    else process.env.CORS_ORIGIN = previousOrigin
  }
})

test('production CORS allows the deployed frontend when CORS_ORIGIN is unset', async () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousCorsOrigin = process.env.CORS_ORIGIN
  process.env.NODE_ENV = 'production'
  delete process.env.CORS_ORIGIN
  try {
    await withApi(async base => {
      const origin = 'https://ecopulse-frontend-3s6c.onrender.com'
      const health = await fetch(`${base}/api/health`, { headers: { Origin: origin } })
      assert.equal(health.status, 200)
      assert.equal(health.headers.get('access-control-allow-origin'), origin)

      const preflight = await fetch(`${base}/api/requests`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' },
      })
      assert.equal(preflight.status, 204)
      assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
      assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET,POST,OPTIONS')
      assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type')
    })
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousCorsOrigin === undefined) delete process.env.CORS_ORIGIN
    else process.env.CORS_ORIGIN = previousCorsOrigin
  }
})

test('CORS parses comma-separated environment origins and normalizes each entry', async () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousCorsOrigin = process.env.CORS_ORIGIN
  process.env.NODE_ENV = 'production'
  process.env.CORS_ORIGIN = ' https://ops.example/ , https://analytics.example '
  try {
    await withApi(async base => {
      for (const origin of ['https://ops.example', 'https://analytics.example']) {
        const response = await fetch(`${base}/api/health`, { headers: { Origin: origin } })
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('access-control-allow-origin'), origin)
      }
      const deployedFrontend = await fetch(`${base}/api/health`, {
        headers: { Origin: 'https://ecopulse-frontend-3s6c.onrender.com' },
      })
      assert.equal(deployedFrontend.status, 200)
    })
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousCorsOrigin === undefined) delete process.env.CORS_ORIGIN
    else process.env.CORS_ORIGIN = previousCorsOrigin
  }
})

test('explicit corsOrigins overrides environment and default origins', async () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousCorsOrigin = process.env.CORS_ORIGIN
  process.env.NODE_ENV = 'production'
  process.env.CORS_ORIGIN = 'https://environment.example'
  try {
    await withApi(async base => {
      const injected = await fetch(`${base}/api/health`, { headers: { Origin: 'https://injected.example' } })
      assert.equal(injected.status, 200)
      const environment = await fetch(`${base}/api/health`, { headers: { Origin: 'https://environment.example' } })
      assert.equal(environment.status, 403)
      const deployedDefault = await fetch(`${base}/api/health`, { headers: { Origin: 'https://ecopulse-frontend-3s6c.onrender.com' } })
      assert.equal(deployedDefault.status, 403)
    }, { corsOrigins: ['https://injected.example'] })
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousCorsOrigin === undefined) delete process.env.CORS_ORIGIN
    else process.env.CORS_ORIGIN = previousCorsOrigin
  }
})

test('development CORS keeps localhost frontend origins', async () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousCorsOrigin = process.env.CORS_ORIGIN
  process.env.NODE_ENV = 'development'
  delete process.env.CORS_ORIGIN
  try {
    await withApi(async base => {
      const response = await fetch(`${base}/api/health`, { headers: { Origin: 'http://localhost:5173' } })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173')
    })
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousCorsOrigin === undefined) delete process.env.CORS_ORIGIN
    else process.env.CORS_ORIGIN = previousCorsOrigin
  }
})

test('validates request creation and creates unique NEW requests with timelines', async () => withApi(async base => {
  assert.equal((await fetch(`${base}/api/requests`, json('POST', { zoneId: 'unknown' }))).status, 400)
  assert.equal((await fetch(`${base}/api/requests`, json('POST', { zoneId: 'maj', fill: 101 }))).status, 400)
  const create = () => fetch(`${base}/api/requests`, json('POST', { zoneId: 'maj', fill: 94 }))
  const [a, b] = await Promise.all([create(), create()])
  const first = await a.json(), second = await b.json()
  assert.equal(a.status, 201)
  assert.notEqual(first.id, second.id)
  assert.equal(first.status, 'NEW')
  assert.equal(first.zone, 'Majestic')
  assert.ok(Date.parse(first.createdAt))
  assert.equal(first.events[0].status, 'NEW')
}))

test('enforces transitions, exclusive assignment, availability and cancellation', async () => withApi(async base => {
  const post = async (path, body = {}) => fetch(`${base}${path}`, json('POST', body))
  assert.equal((await post('/api/requests/missing/assign', { vehicleId: 'V-01' })).status, 404)
  const a = await (await post('/api/requests', { zoneId: 'maj' })).json()
  const b = await (await post('/api/requests', { zoneId: 'heb' })).json()
  assert.equal((await post(`/api/requests/${a.id}/dispatch`)).status, 409)
  assert.equal((await post(`/api/requests/${a.id}/assign`, { vehicleId: 'V-99' })).status, 400)
  const assignedResponse = await post(`/api/requests/${a.id}/assign`, { vehicleId: 'V-01' })
  const assigned = await assignedResponse.json()
  assert.equal(assignedResponse.status, 200)
  assert.equal(assigned.status, 'ASSIGNED')
  assert.equal(assigned.vehicleId, 'V-01')
  assert.deepEqual(assigned.events.map(event => event.status), ['NEW', 'ASSIGNED'])
  assert.equal((await post(`/api/requests/${b.id}/assign`, { vehicleId: 'V-01' })).status, 409)
  const occupied = (await fetch(`${base}/api/vehicles`).then(r => r.json())).find(v => v.id === 'V-01')
  assert.equal(occupied.available, false)
  assert.equal(occupied.assignedRequestId, a.id)
  assert.equal((await post(`/api/requests/${a.id}/dispatch`)).status, 200)
  assert.equal((await post(`/api/requests/${a.id}/complete`)).status, 200)
  assert.equal((await (await fetch(`${base}/api/vehicles`)).json()).find(v => v.id === 'V-01').available, true)
  assert.equal((await post(`/api/requests/${b.id}/cancel`)).status, 200)
}))

test('request status and event timeline persist when the SQLite database is reopened', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'ecopulse-api-'))
  const path = join(folder, 'persist.sqlite')
  let db = createDatabase(path)
  let server = createServer(createApp({ db }))
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const created = await fetch(`${base}/api/requests`, json('POST', { zoneId: 'maj' })).then(r => r.json())
    await fetch(`${base}/api/requests/${created.id}/assign`, json('POST', { vehicleId: 'V-02' }))
    await new Promise(resolve => server.close(resolve)); db.close()
    db = createDatabase(path)
    server = createServer(createApp({ db }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const persisted = await fetch(`http://127.0.0.1:${server.address().port}/api/requests`).then(r => r.json())
    assert.equal(persisted[0].id, created.id)
    assert.equal(persisted[0].status, 'ASSIGNED')
    assert.equal(persisted[0].vehicleId, 'V-02')
    assert.deepEqual(persisted[0].events.map(event => event.status), ['NEW', 'ASSIGNED'])
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    db.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test('notification endpoint records a simulated in-app event only', async () => withApi(async base => {
  const request = await fetch(`${base}/api/requests`, json('POST', { zoneId: 'maj' })).then(r => r.json())
  const response = await fetch(`${base}/api/notifications/simulate`, json('POST', { requestId: request.id }))
  const event = await response.json()
  assert.equal(response.status, 201)
  assert.equal(event.simulated, true)
  assert.equal(event.requestId, request.id)
  assert.match(event.message, /No external message was sent/)
  assert.equal((await (await fetch(`${base}/api/notifications`)).json()).length, 1)
  const audit = await fetch(`${base}/api/audit/events?status=NOTIFIED`).then(r => r.json())
  assert.equal(audit.pagination.total, 1)
}))

test('demo reset requires explicit confirmation and clears only local demo records', async () => withApi(async base => {
  const create = await fetch(`${base}/api/requests`, json('POST', { zoneId: 'maj' }))
  assert.equal(create.status, 201)
  await fetch(`${base}/api/notifications/simulate`, json('POST', { zoneId: 'maj' }))
  assert.equal((await fetch(`${base}/api/demo/reset`, json('POST', {}))).status, 400)
  assert.equal((await fetch(`${base}/api/requests`).then(r => r.json())).length, 1)
  const reset = await fetch(`${base}/api/demo/reset`, json('POST', { confirm: true }))
  assert.equal(reset.status, 200)
  assert.deepEqual(await fetch(`${base}/api/requests`).then(r => r.json()), [])
  assert.deepEqual(await fetch(`${base}/api/notifications`).then(r => r.json()), [])
  assert.equal((await fetch(`${base}/api/zones`).then(r => r.json())).length, 12)
}, { allowDemoReset: true }))

test('demo reset is disabled when the server is configured for production', async () => withApi(async base => {
  const create = await fetch(`${base}/api/requests`, json('POST', { zoneId: 'maj' }))
  assert.equal(create.status, 201)
  const reset = await fetch(`${base}/api/demo/reset`, json('POST', { confirm: true }))
  assert.equal(reset.status, 403)
  assert.equal((await fetch(`${base}/api/requests`).then(r => r.json())).length, 1)
}, { allowDemoReset: false }))

test('zone API shares explainable risk assessment and category thresholds', async () => withApi(async base => {
  const zones = await fetch(`${base}/api/zones`).then(r => r.json())
  const majestic = zones.find(z => z.id === 'maj')
  assert.equal(majestic.category, 'Critical')
  assert.equal(majestic.risk, 93)
  assert.equal(Math.round(majestic.riskFactors.fill + majestic.riskFactors.growth + majestic.riskFactors.highFill), 93)
  assert.match(majestic.explanation, /Estimated overflow/)
  assert.match(majestic.explanation, /Dispatch immediately/)
}))

test('audit feed records committed lifecycle events with pagination and filters', async () => withApi(async base => {
  const post = (path, body = {}) => fetch(`${base}${path}`, json('POST', body))
  const createdResponse = await post('/api/requests', { zoneId: 'maj' })
  const created = await createdResponse.json()
  assert.equal(createdResponse.status, 201)
  await post(`/api/requests/${created.id}/assign`, { vehicleId: 'V-01' })
  await post(`/api/requests/${created.id}/dispatch`)
  await post(`/api/requests/${created.id}/complete`)
  const cancelled = await post('/api/requests', { zoneId: 'heb' }).then(r => r.json())
  await post(`/api/requests/${cancelled.id}/cancel`)

  const response = await fetch(`${base}/api/audit/events?limit=2&offset=2`)
  const report = await response.json()
  assert.equal(response.status, 200)
  assert.equal(report.dataMode, 'SYNTHETIC_DEMO')
  assert.match(report.disclaimer, /not evidence of real municipal operations/)
  assert.ok(Date.parse(report.generatedAt))
  assert.deepEqual(report.pagination, { limit: 2, offset: 2, total: 6, hasMore: true })
  assert.deepEqual(report.events.map(event => event.status), ['COMPLETED', 'DISPATCHED'])
  assert.equal(report.events[0].eventType, 'COMPLETED')
  assert.equal(report.events[0].requestId, created.id)
  assert.equal(report.events[0].zone, 'Majestic')
  assert.ok(Date.parse(report.events[0].at))
  assert.equal((await fetch(`${base}/api/audit/events?status=NEW`).then(r => r.json())).pagination.total, 2)
  assert.equal((await fetch(`${base}/api/audit/events?status=CANCELLED`).then(r => r.json())).pagination.total, 1)
  assert.equal((await fetch(`${base}/api/audit/events?status=NOTIFIED`).then(r => r.json())).pagination.total, 0)
  assert.equal((await fetch(`${base}/api/audit/events?limit=100&offset=0`)).status, 200)
}))

test('audit feed rejects invalid or ambiguous pagination and status filters', async () => withApi(async base => {
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=-1', 'limit=999999999999999999999', 'offset=-1', 'offset=10001', 'offset=abc', 'status=', 'status=ROOT', 'status=NEW&status=CANCELLED']) {
    const response = await fetch(`${base}/api/audit/events?${query}`)
    const body = await response.json()
    assert.equal(response.status, 400, query)
    assert.ok(body.requestId, query)
  }
}))

test('request validation and status retries do not create incorrect audit entries', async () => withApi(async base => {
  const malformed = await fetch(`${base}/api/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).requestId, malformed.headers.get('x-request-id'))
  const invalidFill = await fetch(`${base}/api/requests`, json('POST', { zoneId: 'maj', fill: '90' }))
  assert.equal(invalidFill.status, 400)
  assert.equal((await fetch(`${base}/api/notifications/simulate`, json('POST', { requestId: 42 }))).status, 400)

  const created = await fetch(`${base}/api/requests`, json('POST', { zoneId: 'maj' })).then(r => r.json())
  const assign = () => fetch(`${base}/api/requests/${created.id}/assign`, json('POST', { vehicleId: 'V-01' }))
  const assignedResponse = await assign()
  const assigned = await assignedResponse.json()
  assert.equal(assignedResponse.status, 200)
  assert.equal(assigned.status, 'ASSIGNED')
  assert.equal(assigned.vehicleId, 'V-01')
  assert.equal((await assign()).status, 409)
  const feed = await fetch(`${base}/api/audit/events`).then(r => r.json())
  assert.equal(feed.pagination.total, 2)
  assert.deepEqual(feed.events.map(event => event.status), ['ASSIGNED', 'NEW'])
}))

test('security headers and request IDs are returned for successful and failed API requests', async () => withApi(async base => {
  const response = await fetch(`${base}/api/health`)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.ok(response.headers.get('x-request-id'))
  const missing = await fetch(`${base}/api/does-not-exist`)
  assert.equal((await missing.json()).requestId, missing.headers.get('x-request-id'))
}))

test('failed event insertion rolls back collection request creation', async () => {
  const db = createDatabase(':memory:')
  db.exec(`CREATE TRIGGER reject_request_event BEFORE INSERT ON request_events
    BEGIN SELECT RAISE(ABORT, 'test event failure'); END;`)
  const app = createApp({ db })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const response = await fetch(`${base}/api/requests`, json('POST', { zoneId: 'maj' }))
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), {
      error: 'The server could not complete the request.',
      requestId: response.headers.get('x-request-id'),
    })
    assert.equal((await fetch(`${base}/api/requests`).then(r => r.json())).length, 0)
    assert.equal((await fetch(`${base}/api/audit/events`).then(r => r.json())).pagination.total, 0)
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    db.close()
  }
})

test('failed assignment event insertion rolls back vehicle reservation and request status', async () => {
  const db = createDatabase(':memory:')
  const app = createApp({ db })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const created = await fetch(`${base}/api/requests`, json('POST', { zoneId: 'maj' })).then(r => r.json())
    db.exec(`CREATE TRIGGER reject_assignment_event BEFORE INSERT ON request_events
      WHEN NEW.status = 'ASSIGNED'
      BEGIN SELECT RAISE(ABORT, 'test assignment event failure'); END;`)

    const response = await fetch(`${base}/api/requests/${created.id}/assign`, json('POST', { vehicleId: 'V-01' }))
    assert.equal(response.status, 500)

    const [request] = await fetch(`${base}/api/requests`).then(r => r.json())
    assert.equal(request.status, 'NEW')
    assert.equal(request.vehicleId, null)
    assert.deepEqual(request.events.map(event => event.status), ['NEW'])
    const vehicle = (await fetch(`${base}/api/vehicles`).then(r => r.json())).find(item => item.id === 'V-01')
    assert.equal(vehicle.available, true)
    assert.equal(vehicle.assignedRequestId, null)
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    db.close()
  }
})
