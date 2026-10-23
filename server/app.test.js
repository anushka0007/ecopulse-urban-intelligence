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
  assert.equal((await post(`/api/requests/${a.id}/assign`, { vehicleId: 'V-01' })).status, 200)
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
  const response = await fetch(`${base}/api/notifications/simulate`, json('POST', { zoneId: 'maj' }))
  const event = await response.json()
  assert.equal(response.status, 201)
  assert.equal(event.simulated, true)
  assert.match(event.message, /No external message was sent/)
  assert.equal((await (await fetch(`${base}/api/notifications`)).json()).length, 1)
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
