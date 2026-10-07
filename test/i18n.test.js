const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ca = require('../src/locales/ca');
const { translate } = require('../src/i18n');
const { STATUS } = require('../src/util');

const root = path.join(__dirname, '..');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

/** Textos visibles: t('…') en las vistas y mensajes/títulos/errores en el servidor. */
function usedKeys() {
  const keys = new Set(Object.values(STATUS).map((s) => s.label));
  for (const f of walk(path.join(root, 'views'))) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) keys.add(m[1]);
  }
  const patterns = [
    /\b(?:req\.)?t\('((?:[^'\\]|\\.)*)'/g,
    /translate\(\w+, '((?:[^'\\]|\\.)*)'/g,
    /flash\(req, [^,]+, '((?:[^'\\]|\\.)*)'/g,
    /\b(?:title|message|error|key|note): '((?:[^'\\]|\\.)*)'/g,
    /\bnote = '((?:[^'\\]|\\.)*)'/g,
    /applyStatus\(req, [^,]+, '\w+', '((?:[^'\\]|\\.)*)'/g,
    /changeStatus\([^,]+, '\w+', [^,]+, '((?:[^'\\]|\\.)*)'/g,
  ];
  for (const f of walk(path.join(root, 'src')).filter((x) => x.endsWith('.js') && !x.includes('locales') && !x.endsWith('i18n.js'))) {
    const s = fs.readFileSync(f, 'utf8');
    for (const re of patterns) for (const m of s.matchAll(re)) keys.add(m[1]);
  }
  return [...keys].filter((k) => /[A-Za-zÁ-ú]/.test(k));
}

test('todos los textos tienen traducción al catalán', () => {
  const missing = usedKeys().filter((k) => !Object.prototype.hasOwnProperty.call(ca, k));
  assert.deepStrictEqual(missing, []);
});

test('las traducciones conservan los parámetros', () => {
  for (const [es, cat] of Object.entries(ca)) {
    const params = (txt) => (txt.match(/\{\w+\}/g) || []).sort().join();
    assert.strictEqual(params(cat), params(es), `parámetros distintos en «${es}»`);
  }
});

test('translate', () => {
  assert.strictEqual(translate('ca', 'Pedido {code}', { code: '#0001' }), 'Comanda #0001');
  assert.strictEqual(translate('es', 'Pedido {code}', { code: '#0001' }), 'Pedido #0001');
  assert.strictEqual(translate('ca', 'Texto sin traducir'), 'Texto sin traducir');
});
