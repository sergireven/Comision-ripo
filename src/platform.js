const path = require('path');

/**
 * Valores por defecto al desplegar en Railway, para no tener que definirlos a mano.
 * Cualquier variable que se defina explícitamente tiene prioridad.
 * - Volumen: la base de datos y las fotos se guardan en el disco persistente.
 * - Dominio público: se usa en los correos y en los QR.
 * - Va detrás de un proxy con HTTPS: cookies seguras.
 */
function applyPlatformDefaults(env = process.env) {
  if (!env.RAILWAY_ENVIRONMENT) return;
  const setDefault = (key, value) => { if (!env[key] && value) env[key] = value; };
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH;
  if (volume) {
    setDefault('DB_PATH', path.join(volume, 'club.db'));
    setDefault('UPLOAD_DIR', path.join(volume, 'uploads'));
  }
  if (env.RAILWAY_PUBLIC_DOMAIN) setDefault('APP_URL', `https://${env.RAILWAY_PUBLIC_DOMAIN}`);
  setDefault('TRUST_PROXY', '1');
  setDefault('COOKIE_SECURE', 'true');
  setDefault('NODE_ENV', 'production');
}

module.exports = { applyPlatformDefaults };
