// Carga el catálogo (artículos y packs) a partir del JSON que genera scripts/catalogo-excel-a-json.py.
//   npm run import-catalog -- catalogo.json img
// Se puede repetir: los artículos y packs se actualizan por nombre (castellano). Los productos que no
// están en el catálogo se ocultan (no se borran, para no afectar a pedidos antiguos).
// Con --si-vacio solo carga si la tienda aún no tiene productos (se usa al arrancar en Railway, para no
// pisar los cambios que la comisión haga después desde el panel).
require('dotenv').config({ quiet: true });
require('../src/platform').applyPlatformDefaults();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openDb } = require('../src/db');
const { slugify } = require('../src/util');

const args = process.argv.slice(2);
const onlyIfEmpty = args.includes('--si-vacio');
const [jsonFile, imgDir = 'img'] = args.filter((a) => !a.startsWith('--'));
if (!jsonFile) {
  console.error('Uso: npm run import-catalog -- catalogo.json [carpeta-de-imagenes] [--si-vacio]');
  process.exit(1);
}
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const db = openDb();
if (onlyIfEmpty && db.prepare('SELECT 1 FROM products LIMIT 1').get()) {
  console.log('La tienda ya tiene productos: no se carga el catálogo.');
  process.exit(0);
}
const catalog = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));

const cents = (v) => Math.round(Number(String(v).replace(',', '.')) * 100);
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const csv = (v) => list(v).join(', ') || null;
const visible = (v) => (/^no$/i.test(String(v ?? '').trim()) ? 0 : 1);
const problems = [];

/** Copia una imagen de la carpeta a uploads/ (reutiliza la ya copiada si el contenido no ha cambiado). */
function copyImage(name, current) {
  if (!name) return null;
  const src = path.join(imgDir, name);
  if (!fs.existsSync(src)) { problems.push(`No existe la imagen ${src}`); return current || null; }
  const buf = fs.readFileSync(src);
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
  const target = `catalogo-${hash}${path.extname(name).toLowerCase()}`;
  if (!fs.existsSync(path.join(uploadDir, target))) fs.writeFileSync(path.join(uploadDir, target), buf);
  return target;
}

function categoryId(name) {
  if (!name) return null;
  const found = db.prepare('SELECT id FROM categories WHERE name = ? OR name_ca = ?').get(name, name);
  if (found) return found.id;
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories').get().m;
  console.log(`  + categoría nueva: ${name}`);
  return db.prepare('INSERT INTO categories (name, slug, sort_order) VALUES (?, ?, ?)').run(name, slugify(name), max + 1).lastInsertRowid;
}

db.transaction(() => {
  const productIds = new Map(); // ID del Excel -> id en la base de datos
  for (const a of catalog.articles) {
    const existing = db.prepare('SELECT * FROM products WHERE name = ?').get(a.name);
    const row = {
      name: a.name, name_ca: a.name_ca || null, description: a.description || null, description_ca: a.description_ca || null,
      category_id: categoryId(a.category), price_cents: cents(a.price),
      personalization: a.personalization ? 1 : 0, sizes: csv(a.sizes), colors: csv(a.colors), options: csv(a.options),
      active: visible(a.visible),
      image: copyImage(a.image, existing?.image), size_guide: copyImage(a.size_guide, existing?.size_guide),
    };
    if (!Number.isInteger(row.price_cents) || row.price_cents < 0) { problems.push(`Precio no válido en «${a.name}»`); continue; }
    if (existing) {
      db.prepare(`UPDATE products SET name_ca = @name_ca, description = @description, description_ca = @description_ca,
        category_id = @category_id, price_cents = @price_cents, personalization = @personalization, sizes = @sizes,
        colors = @colors, options = @options, active = @active, image = @image, size_guide = @size_guide WHERE id = @id`)
        .run({ ...row, id: existing.id });
      productIds.set(String(a.id), existing.id);
      console.log(`  = ${a.name}`);
    } else {
      const info = db.prepare(`INSERT INTO products (name, name_ca, description, description_ca, category_id, price_cents,
        personalization, sizes, colors, options, active, image, size_guide)
        VALUES (@name, @name_ca, @description, @description_ca, @category_id, @price_cents, @personalization, @sizes,
        @colors, @options, @active, @image, @size_guide)`).run(row);
      productIds.set(String(a.id), info.lastInsertRowid);
      console.log(`  + ${a.name}`);
    }
  }

  // Productos que ya no están en el catálogo: se ocultan.
  const keep = [...productIds.values()];
  const hidden = db.prepare(`UPDATE products SET active = 0 WHERE active = 1 AND id NOT IN (${keep.map(() => '?').join(',') || 'NULL'})`).run(...keep);
  if (hidden.changes) console.log(`  · ${hidden.changes} producto(s) que no están en el catálogo se han ocultado`);

  for (const p of catalog.packs) {
    const existing = db.prepare('SELECT * FROM packs WHERE name = ?').get(p.name);
    const row = {
      name: p.name, name_ca: p.name_ca || null, description: p.description || null, description_ca: p.description_ca || null,
      price_cents: cents(p.price), active: visible(p.visible), image: copyImage(p.image, existing?.image),
    };
    let packId;
    if (existing) {
      db.prepare(`UPDATE packs SET name_ca = @name_ca, description = @description, description_ca = @description_ca,
        price_cents = @price_cents, active = @active, image = @image WHERE id = @id`).run({ ...row, id: existing.id });
      packId = existing.id;
      console.log(`  = ${p.name}`);
    } else {
      packId = db.prepare(`INSERT INTO packs (name, name_ca, description, description_ca, price_cents, active, image)
        VALUES (@name, @name_ca, @description, @description_ca, @price_cents, @active, @image)`).run(row).lastInsertRowid;
      console.log(`  + ${p.name}`);
    }
    const gifts = new Set(list(p.gifts));
    const members = catalog.articles.filter((a) => list(a.packs).includes(String(p.id))).map((a) => String(a.id));
    for (const g of gifts) if (!members.includes(g)) problems.push(`Pack «${p.name}»: el regalo ${g} no tiene el pack en «Incluido en packs»`);
    db.prepare('DELETE FROM pack_items WHERE pack_id = ?').run(packId);
    for (const id of members) {
      if (!productIds.has(id)) { problems.push(`Pack «${p.name}»: el artículo ${id} no existe`); continue; }
      db.prepare('INSERT INTO pack_items (pack_id, product_id, gift) VALUES (?, ?, ?)').run(packId, productIds.get(id), gifts.has(id) ? 1 : 0);
    }
  }
})();

if (problems.length) {
  console.log('\nAvisos:');
  for (const p of problems) console.log(`  ! ${p}`);
}
console.log(`\nCatálogo cargado: ${catalog.articles.length} artículos y ${catalog.packs.length} packs.`);
