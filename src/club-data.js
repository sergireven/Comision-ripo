const path = require('path');
const { execFile } = require('child_process');

/**
 * Datos de los equipos del CH Ripollet (clasificación, resultados y próximos partidos) para Pollet.
 * Salen de okCat360 (https://okcat360.vercel.app/data.json), que recopila cada día los datos de la federación.
 * La descarga y el análisis (~40 MB) se hacen en un proceso aparte; aquí solo se guarda un resumen pequeño.
 */
const SOURCE_URL = process.env.CLUB_DATA_URL || 'https://okcat360.vercel.app/data.json';
const CLUB_RE = /ripollet/i;
const REFRESH_MS = 12 * 3600 * 1000;

/** «CH RIPOLLET A» y «Ch Ripollet A» → «ripollet a» */
const teamKey = (name) => String(name || '').toLowerCase()
  .replace(/club hoquei|\bc\.?\s?h\.?\b/g, '').replace(/\s+/g, ' ').trim();

const parseDate = (s) => {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(s || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};

/** De data.json de okCat360 al resumen de los equipos del club. */
function extractClub(data, today = new Date().toISOString().slice(0, 10)) {
  const teams = [];
  for (const [category, comps] of Object.entries(data.categories || {})) {
    for (const comp of comps) {
      for (const row of comp.classification || []) {
        if (!CLUB_RE.test(row.team)) continue;
        const key = teamKey(row.team);
        const games = (comp.calendar || []).filter((g) => teamKey(g.home) === key || teamKey(g.away) === key)
          .map((g) => ({ jornada: g.jornada, date: parseDate(g.date), time: g.time || '', home: g.home, away: g.away,
            played: Boolean(g.played), score: g.played ? `${g.homeScore}-${g.awayScore}` : null }))
          .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
        teams.push({
          category,
          competition: String(comp.name || '').replace(/\s*\(\d{4}-\d{2}\)\s*$/, ''),
          team: row.team,
          standing: { pos: row.pos, of: (comp.classification || []).length, pts: row.pts, pj: row.pj, pg: row.pg, pe: row.pe, pp: row.pp, gf: row.gf, gc: row.gc },
          recent: games.filter((g) => g.played).slice(-3),
          pending: games.filter((g) => !g.played && g.date && g.date < today).slice(-2),
          upcoming: games.filter((g) => !g.played && g.date >= today).slice(0, 3),
        });
      }
    }
  }
  return { season: data.season || '', sourceUpdatedAt: data.updatedAt || null, teams };
}

const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

/** Texto para la «chuleta» de Pollet. */
function clubDataText(summary) {
  if (!summary || !summary.teams || !summary.teams.length) return '';
  const lines = summary.teams.map((t) => {
    const s = t.standing;
    const game = (g) => `J${g.jornada} ${fmtDate(g.date)}${g.time ? ` ${g.time}` : ''}: ${g.home} - ${g.away}${g.score ? ` (${g.score})` : ''}`;
    return [`- ${t.team} · ${t.category} · ${t.competition}: ${s.pos}º de ${s.of}, ${s.pts} puntos (${s.pj} jugados: ${s.pg} ganados, ${s.pe} empatados, ${s.pp} perdidos; goles ${s.gf} a favor, ${s.gc} en contra).`,
      t.recent.length ? `  Últimos resultados: ${t.recent.map(game).join(' | ')}` : '',
      t.pending.length ? `  Sin resultado todavía (aplazado o pendiente de acta): ${t.pending.map(game).join(' | ')}` : '',
      t.upcoming.length ? `  Próximos partidos: ${t.upcoming.map(game).join(' | ')}` : '  Próximos partidos: no hay fechas publicadas.',
    ].filter(Boolean).join('\n');
  });
  const when = summary.sourceUpdatedAt ? new Date(summary.sourceUpdatedAt).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' }) : '';
  return `# Equipos del CH Ripollet en la temporada ${summary.season} (datos de la federación vía okCat360${when ? `, actualizados el ${when}` : ''})
En los partidos, el primer equipo juega en casa. Más detalle (actas, clasificaciones completas): https://okcat360.vercel.app y https://www.hoqueipatins.fecapa.cat/ag/
${lines.join('\n')}`;
}

/** Descarga y resume en un proceso aparte (si se queda sin memoria, la tienda no se cae). */
function fetchSummary() {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--max-old-space-size=1536', path.join(__dirname, '..', 'scripts', 'club-data-worker.js'), SOURCE_URL],
      { timeout: 180000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
      });
  });
}

function createClubData(db) {
  const save = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const load = db.prepare("SELECT value FROM settings WHERE key = 'club_data'");

  function get() {
    try { return JSON.parse(load.get()?.value || 'null'); } catch { return null; }
  }
  function store(summary) {
    save.run('club_data', JSON.stringify({ ...summary, fetchedAt: new Date().toISOString() }));
  }
  async function refresh() {
    try {
      const summary = await fetchSummary();
      if (!summary.teams?.length) throw new Error('sin equipos del club en los datos');
      store(summary);
      console.log(`Datos del club actualizados: ${summary.teams.length} equipos (temporada ${summary.season}).`);
    } catch (err) {
      console.error('Datos del club: no se han podido actualizar', err.message);
    }
  }
  /** Al arrancar (si los datos tienen más de 12 h) y luego cada 12 h. */
  function start() {
    const current = get();
    const age = current?.fetchedAt ? Date.now() - new Date(current.fetchedAt).getTime() : Infinity;
    setTimeout(refresh, age > REFRESH_MS ? 15000 : REFRESH_MS - age).unref();
    setInterval(refresh, REFRESH_MS).unref();
  }
  return { get, store, refresh, start, text: () => clubDataText(get()) };
}

module.exports = { extractClub, clubDataText, createClubData, teamKey };
