/**
 * Startpunkt för x-time. Kontrollerar Node-versionen innan något annat laddas, eftersom databasen kräver
 * node:sqlite och ett för gammalt Node annars bara ger ett obegripligt fel.
 *   node src/start.js        startar servern
 *   node src/start.js demo   startar med demodata
 */
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`x-time kräver Node.js 22.13 eller nyare. Den här datorn har ${process.versions.node}.`);
  console.error('Installera den senaste LTS-versionen från https://nodejs.org och starta igen.');
  process.exit(1);
}

// SQLite i Node är märkt som experimentell. Varningen säger inget om x-time och visas inte.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning') return;
  emitWarning.call(process, warning, ...rest);
};

await import(process.argv[2] === 'demo' ? '../scripts/demo.js' : './server.js');
