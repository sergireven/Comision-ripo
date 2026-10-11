// Proceso aparte: descarga data.json de okCat360 y escribe por la salida estándar el resumen de los equipos del club.
// Uso: node scripts/club-data-worker.js <url>
const { extractClub } = require('../src/club-data');

(async () => {
  const url = process.argv[2];
  const res = await fetch(url, { headers: { 'User-Agent': 'botiga-ch-ripollet' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${url}`);
  const summary = extractClub(await res.json());
  process.stdout.write(JSON.stringify(summary));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
