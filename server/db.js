import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assessZone } from '../shared/risk.js'

export const demoZones = [
  ['heb', 'Hebbal', 13.0358, 77.597, 78, 2.7, 420],
  ['yel', 'Yelahanka', 13.1007, 77.5963, 42, 1.6, 310],
  ['mal', 'Malleshwaram', 13.0031, 77.5643, 64, 2.1, 380],
  ['raj', 'Rajajinagar', 13.0108, 77.555, 88, 3.1, 510],
  ['maj', 'Majestic', 12.9767, 77.5713, 94, 3.8, 620],
  ['shi', 'Shivajinagar', 12.9857, 77.6057, 71, 2.5, 430],
  ['ind', 'Indiranagar', 12.9784, 77.6408, 55, 2, 350],
  ['whi', 'Whitefield', 12.9698, 77.75, 82, 3.4, 560],
  ['mar', 'Marathahalli', 12.9591, 77.6974, 91, 3.6, 540],
  ['kor', 'Koramangala', 12.9352, 77.6245, 48, 1.8, 330],
  ['jay', 'Jayanagar', 12.925, 77.5838, 67, 2.2, 400],
  ['ele', 'Electronic City', 12.8399, 77.677, 36, 1.3, 280],
].map(([id, name, lat, lng, fill, growth, baseLoad]) => ({ id, name, lat, lng, fill, growth, baseLoad }))

export const demoVehicles = [
  { id: 'V-01', name: 'Compactor 01', capacity: 1800 },
  { id: 'V-02', name: 'Compactor 02', capacity: 1500 },
  { id: 'V-03', name: 'Mini truck 03', capacity: 900 },
  { id: 'V-04', name: 'Compactor 04', capacity: 1800 },
]

export function calculateZone(zone, fill = zone.fill) {
  const assessment = assessZone(zone, fill)
  return { ...zone, fill, ...assessment, load: Math.round(zone.baseLoad * fill / 100) }
}

const defaultDatabasePath = process.env.ECOPULSE_DB_PATH
  || (process.env.RENDER ? '/var/data/ecopulse.sqlite' : resolve('server/data/ecopulse.sqlite'))

export function createDatabase(databasePath = defaultDatabasePath) {
  const path = databasePath === ':memory:' ? databasePath : resolve(databasePath)
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS zones (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
      fill REAL NOT NULL, growth REAL NOT NULL, base_load REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vehicles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, capacity REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, zone_id TEXT NOT NULL REFERENCES zones(id), zone_name TEXT NOT NULL,
      fill REAL NOT NULL, risk INTEGER NOT NULL, category TEXT NOT NULL, eta REAL NOT NULL,
      load REAL NOT NULL, reason TEXT NOT NULL, action TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('NEW','ASSIGNED','DISPATCHED','COMPLETED','CANCELLED')),
      vehicle_id TEXT REFERENCES vehicles(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS requests_status_vehicle_idx ON requests(status, vehicle_id);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_request_per_vehicle
      ON requests(vehicle_id) WHERE vehicle_id IS NOT NULL AND status IN ('ASSIGNED','DISPATCHED');
    CREATE INDEX IF NOT EXISTS requests_created_idx ON requests(created_at DESC);
    CREATE TABLE IF NOT EXISTS request_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      status TEXT NOT NULL, at TEXT NOT NULL, detail TEXT
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, request_id TEXT REFERENCES requests(id), zone_id TEXT REFERENCES zones(id),
      zone_name TEXT, at TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'MUNICIPAL_NOTIFICATION',
      simulated INTEGER NOT NULL DEFAULT 1 CHECK(simulated = 1)
    );
  `)

  const insertZone = db.prepare('INSERT OR IGNORE INTO zones (id,name,lat,lng,fill,growth,base_load) VALUES (?,?,?,?,?,?,?)')
  for (const z of demoZones) insertZone.run(z.id, z.name, z.lat, z.lng, z.fill, z.growth, z.baseLoad)
  const insertVehicle = db.prepare('INSERT OR IGNORE INTO vehicles (id,name,capacity) VALUES (?,?,?)')
  for (const v of demoVehicles) insertVehicle.run(v.id, v.name, v.capacity)
  return db
}
