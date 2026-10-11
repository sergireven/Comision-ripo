require('dotenv').config({ quiet: true });
require('./platform').applyPlatformDefaults();

const { openDb } = require('./db');
const { createApp } = require('./app');
const { createClubData } = require('./club-data');

if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  console.error('Falta SESSION_SECRET en el entorno (.env).');
  process.exit(1);
}

const db = openDb();
const app = createApp(db);
// Partidos y clasificaciones del club para Ripo (okCat360): al arrancar si están viejos y luego cada 12 horas.
if (process.env.ANTHROPIC_API_KEY) createClubData(db).start();
const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`Tienda del club escuchando en http://localhost:${port}`);
  if (!process.env.BREVO_API_KEY && !process.env.SMTP_HOST) console.log('Aviso: correo no configurado (ni BREVO_API_KEY ni SMTP_HOST); los correos solo se guardan en Admin > Correos.');
});
