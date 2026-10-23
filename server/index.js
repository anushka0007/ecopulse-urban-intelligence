import { createServer } from 'node:http'
import { createApp } from './app.js'

const port = Number(process.env.PORT || 3001)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.')
}
const app = createApp()
const server = createServer(app)
server.listen(port, '0.0.0.0', () => console.log(`EcoPulse API listening on 0.0.0.0:${port}`))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => {
    app.locals.db.close()
    process.exit(0)
  }))
}
