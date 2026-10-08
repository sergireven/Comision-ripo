/**
 * Packs en el carrito: dados los artículos (unidades por producto) y los packs disponibles,
 * busca la combinación de packs que más ahorra a la familia.
 *
 * - Cada pack necesita una unidad de cada uno de sus productos (los de regalo no cuentan: se añaden gratis).
 * - Un pack puede aplicarse varias veces (2 camisetas + 2 bufandas = 2 packs).
 * - Solo se consideran packs que salen más baratos que sus productos por separado.
 */

/**
 * @param {Object<number, number>} counts unidades por product_id
 * @param {Object<number, number>} prices precio unitario (céntimos) por product_id
 * @param {Array<{id, price_cents, items: Array<{product_id, gift}>}>} packs
 * @returns {Array<{pack, components: number[], regular: number, saving: number}>} un elemento por pack aplicado
 */
function bestPacks(counts, prices, packs) {
  const candidates = [];
  for (const pack of packs) {
    const components = pack.items.filter((i) => !i.gift).map((i) => i.product_id);
    if (!components.length || components.some((id) => prices[id] === undefined)) continue;
    const regular = components.reduce((sum, id) => sum + prices[id], 0);
    const saving = regular - pack.price_cents;
    if (saving > 0) candidates.push({ pack, components, regular, saving });
  }
  if (!candidates.length) return [];

  const ids = [...new Set(candidates.flatMap((c) => c.components))];
  // Búsqueda exacta para carritos normales; con cantidades enormes, aproximación (primero el pack que más ahorra).
  const states = ids.reduce((n, id) => n * ((counts[id] || 0) + 1), candidates.length);
  if (states > MAX_STATES) return greedy(counts, candidates);

  const memo = new Map();
  // best(i, cnt): mejor ahorro usando los candidatos i.. con las unidades que quedan.
  function best(i, cnt) {
    if (i >= candidates.length) return { saving: 0, picks: [] };
    const key = `${i}|${ids.map((id) => cnt[id] || 0).join(',')}`;
    if (memo.has(key)) return memo.get(key);
    let result = best(i + 1, cnt);
    const c = candidates[i];
    if (c.components.every((id) => (cnt[id] || 0) > 0)) {
      const next = { ...cnt };
      for (const id of c.components) next[id] -= 1;
      const withPack = best(i, next);
      if (withPack.saving + c.saving > result.saving) {
        result = { saving: withPack.saving + c.saving, picks: [i, ...withPack.picks] };
      }
    }
    memo.set(key, result);
    return result;
  }
  return best(0, counts).picks.map((i) => candidates[i]);
}

const MAX_STATES = 100000;

function greedy(counts, candidates) {
  const left = { ...counts };
  const picks = [];
  for (const c of [...candidates].sort((a, b) => b.saving - a.saving)) {
    while (c.components.every((id) => (left[id] || 0) > 0)) {
      for (const id of c.components) left[id] -= 1;
      picks.push(c);
    }
  }
  return picks;
}

module.exports = { bestPacks };
