const crypto = require('crypto');

const TZ = 'Europe/Madrid';

// Alfabeto sin caracteres ambiguos (0/O, 1/I/L) para claves y códigos que se dictan o se teclean.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomString(length, alphabet = ALPHABET) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Clave legible tipo "RIPO-K7QM-3XTA". */
function generatePassword() {
  return `RIPO-${randomString(4)}-${randomString(4)}`;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Normaliza un DNI/NIE: mayúsculas, sin espacios, puntos ni guiones. */
function normalizeDni(value) {
  return String(value || '').toUpperCase().replace(/[\s.\-]/g, '');
}

function isValidDni(value) {
  const dni = normalizeDni(value);
  const m = /^([XYZ]|\d)(\d{7})([A-Z])$/.exec(dni);
  if (!m) return false;
  const prefix = { X: '0', Y: '1', Z: '2' }[m[1]] ?? m[1];
  const letters = 'TRWAGMYFPDXBNJZSQVHLCKE';
  return letters[Number(prefix + m[2]) % 23] === m[3];
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function formatMoney(cents) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format((cents || 0) / 100);
}

/** "12,50" | "12.5" | "12" -> 1250 céntimos. Devuelve null si no es válido. */
function parseMoney(value) {
  const str = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(str)) return null;
  return Math.round(Number(str) * 100);
}

function formatDate(iso, withTime = true, lang = 'es') {
  if (!iso) return '';
  const opts = { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return new Intl.DateTimeFormat(lang === 'ca' ? 'ca-ES' : 'es-ES', opts).format(new Date(iso));
}

/** ISO -> valor para <input type="datetime-local"> en hora de Madrid. */
function toLocalInput(iso) {
  if (!iso) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Valor de <input type="datetime-local"> (hora de Madrid) -> ISO UTC. */
function fromLocalInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  // Se calcula el desfase de Madrid para esa fecha (tiene en cuenta horario de verano).
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const local = toLocalInput(new Date(guess).toISOString());
    const [ly, lmo, ld, lh, lmi] = local.split(/[-T:]/).map(Number);
    const diff = Date.UTC(ly, lmo - 1, ld, lh, lmi) - Date.UTC(y, mo - 1, d, h, mi);
    guess -= diff;
  }
  return new Date(guess).toISOString();
}

function slugify(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'categoria';
}

const STATUS = {
  pendiente_pago: { label: 'Pendiente de pago', css: 'warn' },
  pendiente_entrega: { label: 'Pagado · pendiente de entrega', css: 'info' },
  entregado: { label: 'Entregado', css: 'ok' },
  cancelado: { label: 'Cancelado', css: 'muted' },
};

function orderCode(id) {
  return `#${String(id).padStart(4, '0')}`;
}

function parseSizes(sizes) {
  return String(sizes || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Texto plano -> párrafos HTML escapados (línea en blanco = párrafo nuevo). */
function paragraphs(text) {
  return String(text || '').trim().split(/\r?\n\s*\r?\n/).filter((p) => p.trim())
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\r?\n/g, '<br>')}</p>`).join('\n');
}

/** Enlace de Instagram a partir de «@usuario», «usuario» o una URL https. */
function instagramUrl(value) {
  const v = String(value || '').trim();
  if (/^https:\/\/(www\.)?instagram\.com\/[\w.\-/?=&%]*$/i.test(v)) return v;
  const handle = v.replace(/^@/, '');
  return /^[\w.]{1,30}$/.test(handle) ? `https://www.instagram.com/${handle}/` : '';
}

module.exports = {
  TZ, randomString, generatePassword, generateToken, sha256, normalizeDni, isValidDni,
  isValidEmail, formatMoney, parseMoney, formatDate, toLocalInput, fromLocalInput, slugify,
  STATUS, orderCode, parseSizes, escapeHtml, paragraphs, instagramUrl,
};
