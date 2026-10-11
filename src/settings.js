/**
 * Textos editables de la web pública. Los campos `_ca` son la versión en catalán
 * (si están vacíos se muestra el castellano, igual que en productos y categorías).
 */
const TEXT_KEYS = ['home_intro', 'home_intro_ca', 'about', 'about_ca'];
const CONTACT_KEYS = ['contact_email', 'contact_phone', 'contact_place', 'contact_instagram'];
// Información extra que solo lee Pollet, el asistente (partidos, club, pueblo…). No se muestra en la web.
const ASSISTANT_KEYS = ['assistant_info'];
const KEYS = [...TEXT_KEYS, ...CONTACT_KEYS, ...ASSISTANT_KEYS];

const DEFAULTS = {
  home_intro: 'Somos la comisión de eventos del Club Hoquei Ripollet. Organizamos las actividades, celebraciones y el marxandatge del club para toda la familia del hockey.',
  home_intro_ca: "Som la comissió d'esdeveniments del Club Hoquei Ripollet. Organitzem les activitats, les celebracions i el marxandatge del club per a tota la família de l'hoquei.",
  about: 'Somos un grupo de familias voluntarias del Club Hoquei Ripollet.\n\nOrganizamos eventos para jugadores, jugadoras y familias, y gestionamos la tienda de marxandatge del club. Todo lo que se recauda revierte en el club.',
  assistant_info: "Partidos, horarios y resultados\n- El calendario, los horarios y los resultados de todos los equipos están en la web de la Federació Catalana de Patinatge: https://www.hoqueipatins.fecapa.cat/ag/ (se elige temporada y categoría).\n- (La comisión puede escribir aquí los próximos partidos, entrenos o eventos importantes.)\n\nEl club\n- Club Hoquei Ripollet: club de hockey patines de Ripollet (según Wikipedia, fundado en 1966).\n\nRipollet (el pueblo)\n- Municipio del Vallès Occidental (Barcelona), en el área metropolitana, a unos 20 km de Barcelona. Unos 40.000 habitantes en poco más de 4 km², muy densamente poblado.\n- Le da nombre el río Ripoll; el nombre aparece escrito por primera vez en 1402. La iglesia de Sant Esteve ya consta en el año 986 y el pueblo tuvo ayuntamiento propio desde 1585.\n- Históricamente vivió de los molinos y la agricultura (sobre todo la viña); en los siglos XIX y XX llegaron la industria del papel y el cartón y una gran inmigración en los años 60.\n- Fiestas: Tres Tombs (enero), Carnaval con el baile de gitanas y el Cabraboc (febrero), caramelles (abril), alfombras de flores de Corpus, Festa Major de Sant Esteve en agosto (con el Ripollet Rock), aplec de la sardana y Festes de la Tardor (septiembre) y trobada de gegants (octubre).\n- Lugares conocidos: parque dels Pinetons, Molí d'en Rata, Can Masachs (Ayuntamiento), Teatre Auditori del Mercat Vell, pabellón Joan Creus y polideportivo municipal.\n- Otros clubes del pueblo: CF Ripollet (1921), CB Ripollet (1931), Club Ciclista Ripollet (1948), Club Handbol Ripollet (1968).",
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

module.exports = { TEXT_KEYS, CONTACT_KEYS, ASSISTANT_KEYS, KEYS, DEFAULTS, getSettings, saveSettings };
