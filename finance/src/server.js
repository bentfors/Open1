import path from 'node:path';
import { config } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { purgeExpiredSessions } from './auth.js';

const db = openDb(path.join(config.dataDir, 'min-ekonomi.sqlite'));

purgeExpiredSessions(db);
const timer = setInterval(() => purgeExpiredSessions(db), 6 * 3600 * 1000);
timer.unref();

const server = createApp({ db });
server.listen(config.port, config.host, () => {
  console.log(`Min ekonomi lyssnar på http://${config.host}:${config.port} (data: ${config.dataDir})`);
  if (config.cookieSecure) console.log('Secure-kakor är på: inloggning kräver https.');
  if (config.host !== '127.0.0.1') console.log('Lyssnar utanför localhost. Kör bakom en https-proxy.');
});

function shutdown() {
  console.log('Stänger ner …');
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
