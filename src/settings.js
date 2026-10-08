/**
 * Textos editables de la web pública. Los campos `_ca` son la versión en catalán
 * (si están vacíos se muestra el castellano, igual que en productos y categorías).
 */
const TEXT_KEYS = ['home_intro', 'home_intro_ca', 'about', 'about_ca'];
const CONTACT_KEYS = ['contact_email', 'contact_phone', 'contact_place', 'contact_instagram'];
const KEYS = [...TEXT_KEYS, ...CONTACT_KEYS];

const DEFAULTS = {
  home_intro: 'Somos la comisión de eventos del Club Hoquei Ripollet. Organizamos las actividades, celebraciones y el marxandatge del club para toda la familia del hockey.',
  home_intro_ca: "Som la comissió d'esdeveniments del Club Hoquei Ripollet. Organitzem les activitats, les celebracions i el marxandatge del club per a tota la família de l'hoquei.",
  about: 'Somos un grupo de familias voluntarias del Club Hoquei Ripollet.\n\nOrganizamos eventos para jugadores, jugadoras y familias, y gestionamos la tienda de marxandatge del club. Todo lo que se recauda revierte en el club.',
  about_ca: "Som un grup de famílies voluntàries del Club Hoquei Ripollet.\n\nOrganitzem esdeveniments per a jugadors, jugadores i famílies, i gestionem la botiga de marxandatge del club. Tot el que es recapta reverteix en el club.",
};

function getSettings(db) {
  const out = { ...DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    if (KEYS.includes(row.key) && row.value !== null) out[row.key] = row.value;
  }
  return out;
}

function saveSettings(db, values) {
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    for (const key of KEYS) if (key in values) upsert.run(key, values[key]);
  })();
}

module.exports = { TEXT_KEYS, CONTACT_KEYS, KEYS, DEFAULTS, getSettings, saveSettings };
