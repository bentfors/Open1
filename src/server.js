import path from 'node:path';
import { config } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { bootstrap } from './seed.js';
import { purgeExpiredSessions } from './auth.js';

const db = openDb(path.join(config.dataDir, 'x-time.sqlite'));

const created = await bootstrap(db, config);
if (created) {
  console.log('─'.repeat(60));
  console.log('Första administratören är skapad.');
  console.log(`  E-post:   ${created.email}`);
  if (created.password) {
    console.log(`  Lösenord: ${created.password}   (visas bara en gång, måste bytas vid första inloggning)`);
  }
  console.log('─'.repeat(60));
}

purgeExpiredSessions(db);
const timer = setInterval(() => purgeExpiredSessions(db), 6 * 3600 * 1000);
timer.unref();

const server = createApp({ db });
server.listen(config.port, config.host, () => {
  console.log(`x-time lyssnar på http://${config.host}:${config.port} (data: ${config.dataDir})`);
  if (config.cookieSecure) console.log('Secure-kakor är på: inloggning kräver https.');
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
