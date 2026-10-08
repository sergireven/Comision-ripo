require('dotenv').config({ quiet: true });
require('./platform').applyPlatformDefaults();

const { openDb } = require('./db');
const { createApp } = require('./app');

if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  console.error('Falta SESSION_SECRET en el entorno (.env).');
  process.exit(1);
}

const db = openDb();
const app = createApp(db);
const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`Tienda del club escuchando en http://localhost:${port}`);
  if (!process.env.SMTP_HOST) console.log('Aviso: SMTP no configurado; los correos solo se guardan en Admin > Correos.');
});
