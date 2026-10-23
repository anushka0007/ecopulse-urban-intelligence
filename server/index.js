import { createServer } from 'node:http'
import { createApp } from './app.js'

const port = Number(process.env.PORT || 3001)
const app = createApp()
const server = createServer(app)
server.listen(port, () => console.log(`EcoPulse demo API listening on http://localhost:${port}`))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => {
    app.locals.db.close()
    process.exit(0)
  }))
}
