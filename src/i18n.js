/**
 * Traducciones castellano / català.
 * Las claves son el propio texto en castellano; `locales/ca.js` tiene su traducción al catalán.
 * Si falta una traducción se muestra el castellano. Admite parámetros: t('Hola {name}', { name }).
 */
const ca = require('./locales/ca');

const LANGS = ['ca', 'es'];
const DEFAULT_LANG = LANGS.includes(process.env.DEFAULT_LANG) ? process.env.DEFAULT_LANG : 'ca';

function translate(lang, key, params) {
  let text = lang === 'ca' && Object.prototype.hasOwnProperty.call(ca, key) ? ca[key] : key;
  if (params) text = text.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m));
  return text;
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/** Idioma de la petición: cookie elegida > preferencia guardada del usuario > navegador > por defecto. */
function detectLang(req, user) {
  const cookie = parseCookies(req.headers.cookie).lang;
  if (LANGS.includes(cookie)) return cookie;
  if (user && LANGS.includes(user.lang)) return user.lang;
  const accept = String(req.headers['accept-language'] || '').toLowerCase();
  if (/\bca\b/.test(accept)) return 'ca';
  if (/^es\b/.test(accept)) return 'es';
  return DEFAULT_LANG;
}

/** Campo traducible de la base de datos: usa `campo_ca` en catalán si existe. */
function localized(lang, obj, field) {
  if (!obj) return '';
  return (lang === 'ca' && obj[`${field}_ca`]) || obj[field] || '';
}

module.exports = { LANGS, DEFAULT_LANG, translate, detectLang, localized };
