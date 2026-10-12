# Manual técnico · Web de la Comissió d'esdeveniments (CH Ripollet)

Documentación de todo lo montado para la web de la comisión: qué piezas hay, dónde vive cada una, cómo se configuró y cómo se mantiene. Pensado para quien tenga que tocarlo dentro de un año sin acordarse de nada.

> **Nunca escribas contraseñas ni claves en este documento** (ni en el repositorio). Las claves viven solo en las variables de Railway y en el `.env` local, que no se sube a GitHub.

---

## 1. Visión general

```
                    Familias y comisión (navegador / móvil)
                                   │  https://comissioevents.clubhoqueiripollet.com
                                   ▼
   Nominalia (DNS del dominio) ──► Railway (servidor Node.js + disco persistente /data)
                                   │        │            │              │
                                   │        │            │              └─► okCat360 (partidos)
                                   │        │            └─► Anthropic API (Ripo, el asistente IA)
                                   │        └─► Brevo (envío de correos)
                                   └─► GitHub (código; cada push publica la web)
```

| Pieza | Para qué | Dónde |
|---|---|---|
| **GitHub** | Código fuente y control de versiones | `github.com/sergireven/Comision-ripo`, rama `claude/ripollet-merch-shop-rz3e4t` |
| **Railway** | Servidor donde corre la web + base de datos (disco) | Proyecto «Comision-ripo», servicio con volumen `comision-ripo-volume` |
| **Nominalia** | Dominio `clubhoqueiripollet.com` y sus DNS | Panel de Nominalia (requiere 2FA del responsable del dominio) |
| **Brevo** | Envío de los correos (cuentas, pedidos, pagos…) | brevo.com, dominio `clubhoqueiripollet.com` autenticado |
| **Anthropic** | IA del asistente «Ripo» (Claude Haiku 5.5) | platform.claude.com |
| **okCat360** | Datos de partidos, resultados y clasificaciones | `okcat360.vercel.app` (repo `sergireven/hoquei-fecapa`) |

**Direcciones:**
- Web pública: **https://comissioevents.clubhoqueiripollet.com**
- Dirección interna de Railway (siempre funciona): https://comision-ripo-production.up.railway.app
- Panel de la comisión: `/admin` (entrar con usuario de comisión, no con correo)

---

## 2. La aplicación

### 2.1 Tecnología
- **Node.js 22+** con **Express 5**, plantillas **EJS**, base de datos **SQLite** (`better-sqlite3`, binario precompilado; por eso `.npmrc` tiene `ignore-scripts=true`).
- Sesiones guardadas en la propia SQLite, protección **CSRF** en todos los formularios, contraseñas con **bcrypt**.
- Web bilingüe: textos en castellano en el código y traducción al catalán en `src/locales/ca.js` (hay una prueba que falla si falta alguna traducción).

### 2.2 Estructura del código
```
src/
  server.js        arranque (lee .env, aplica valores de Railway, arranca el refresco de partidos)
  app.js           Express: sesiones, CSRF, idioma, redirección de dominios antiguos, ruta /asistente
  db.js            esquema SQLite + migraciones (lista COLUMNS) + primer admin (ADMIN_USER)
  platform.js      valores por defecto en Railway (DB en el volumen, APP_URL, cookies seguras…)
  services.js      carrito, packs, pedidos y estados
  packs.js         cálculo de la mejor combinación de packs
  mailer.js        correos (Brevo por API; SMTP como alternativa)
  assistant.js     Ripo: instrucciones, «chuleta» con catálogo/pedidos/club y llamada a Claude
  club-data.js     resumen de los equipos del CH Ripollet a partir de okCat360
  settings.js      textos editables de la web (incluidos los de Ripo)
  routes/          site.js (portada), auth.js (cuentas), shop.js (tienda), admin.js (panel)
views/             plantillas EJS (partials/assistant.ejs = el chat; admin/manuals.ejs = sección Manuals)
public/            CSS, JS del navegador (assistant.js = chat con voz), imágenes (pollet.png, ripo-ripo.png, escut.gif)
scripts/           import-catalog.js, catalogo-excel-a-json.py, club-data-worker.js, create-admin.js, seed-demo.js
test/              pruebas automáticas (npm test)
catalogo.json      catálogo inicial (generado desde el Excel) · img/ fotos y guías de tallas
docs/              este manual (MANUAL-TECNICO.md) y los PDF que se ven en Admin › Manuals:
                   manual-tecnico.pdf, manual-comissio.pdf, manual-families.pdf
```

### 2.3 Funciones principales
- **Familias**: crean su cuenta con nombre y apellidos + correo (contraseña en pantalla y por correo), compran, ven sus pedidos y su **QR único** (sirve para pagar y para recoger), cancelan mientras no esté pagado, recuperan contraseña por enlace.
- **Tienda**: colores, modelos, tallas, personalización (obligatoria u opcional con «Sin personalizar»), guías de tallas, **packs automáticos** con la combinación que más ahorra y regalos.
- **Comisión** (`/admin`): panel con totales, caja por persona y **uso de Ripo**, pedidos (filtros, marcar pagado/entregado, eliminar), escáner QR, aviso de recogida, resumen para el proveedor, CSV, productos, packs, periodos, clientes, textos de la web (incluidos los de Ripo), **Manuals** (los PDF de documentación), administradores y registro de correos.
- **Ripo** (asistente IA): ver apartado 8.

---

## 3. Trabajar en local

### 3.1 Requisitos
- **Node.js 22 o superior** (nodejs.org, versión LTS).
- **Git**.
- **Python 3 + openpyxl** (solo para convertir el Excel del catálogo).

### 3.2 Puesta en marcha
```bash
git clone https://github.com/sergireven/Comision-ripo.git
cd Comision-ripo
git checkout claude/ripollet-merch-shop-rz3e4t
npm install
cp .env.example .env      # y rellenar lo necesario (ver apartado 4.3)
npm run seed-demo         # datos de ejemplo (opcional)
npm start                 # http://localhost:3000
```
- `npm run dev` recarga al guardar. `npm test` lanza las pruebas (deben pasar todas antes de subir nada).
- En local, sin `BREVO_API_KEY` ni `SMTP_HOST`, los correos **no se envían**: quedan en *Admin › Correos*.
- Sin `ANTHROPIC_API_KEY`, Ripo no aparece.

### 3.3 Subir cambios (y publicar)
```bash
npm test
git add <archivos>
git commit -m "Descripción del cambio"
git push
```
Railway está conectado a la rama `claude/ripollet-merch-shop-rz3e4t`: **cada `git push` publica la web automáticamente** en 1-3 minutos (se ve en Railway › Deployments).

---

## 4. Railway (servidor)

### 4.1 Cómo está montado
- Servicio creado desde el repositorio de GitHub (Railway › New Project › Deploy from GitHub repo), apuntando a la rama de arriba.
- **Volumen** `comision-ripo-volume` montado en **`/data`**: ahí viven la base de datos (`/data/club.db`) y las fotos subidas (`/data/uploads`). Sin volumen, cada publicación borraría los datos.
- `railway.json`: al arrancar ejecuta `import-catalog.js … --si-vacio` (carga el catálogo **solo si la base está vacía**) y luego `node src/server.js`; comprueba que `/` responde.
- Región US East, 1 réplica, Node 22.

### 4.2 Dominio propio
- Railway › servicio › Settings › Networking › **Custom Domain**: `comissioevents.clubhoqueiripollet.com` (puerto 8080).
- Railway da **dos registros** que hay que crear en Nominalia (ver 5.3): un CNAME y un TXT `_railway-verify`. Cuando los detecta, el dominio sale en verde y genera el certificado HTTPS solo.
- **Límite del plan**: solo 1 dominio propio. Para cambiarlo hay que **borrar** el anterior (el lápiz solo cambia el puerto) y añadir el nuevo. Antes fue `botiga.clubhoqueiripollet.com` (ya no se usa). Con el plan Hobby se pueden tener varios.

### 4.3 Variables (Railway › Variables)
| Variable | Valor / uso |
|---|---|
| `SESSION_SECRET` | Cadena larga aleatoria (obligatoria). |
| `APP_URL` | `https://comissioevents.clubhoqueiripollet.com` — se usa en enlaces y QR de los correos. **No dejar `localhost`.** |
| `ADMIN_USER`, `ADMIN_PASSWORD`, `ADMIN_EMAIL` | Crean el primer administrador al arrancar (solo si no existe). |
| `BREVO_API_KEY` | Clave de Brevo (envío de correos). |
| `MAIL_FROM` | `Comissió Events CH Ripollet <info@clubhoqueiripollet.com>` (remitente). |
| `ADMIN_NOTIFY_EMAIL` | Opcional: correo que recibe aviso de cada pedido nuevo o cancelado. |
| `ANTHROPIC_API_KEY` | Clave de Anthropic (activa a Ripo). |
| `ASSISTANT_USER_DAILY_LIMIT`, `ASSISTANT_DAILY_LIMIT` | Opcionales: preguntas a Ripo por persona/día (30) y totales/día (500). |
| `ASSISTANT_MODEL` | Opcional: modelo de Ripo (por defecto `claude-haiku-5-5`). |
| `CLUB_DATA_URL` | Opcional: fuente de partidos (por defecto `https://okcat360.vercel.app/data.json`). |
| `DEFAULT_LANG`, `CLUB_NAME` | Opcionales. |

Se rellenan solas en Railway (no hace falta crearlas): `DB_PATH`, `UPLOAD_DIR` (en el volumen), `TRUST_PROXY`, `COOKIE_SECURE`, `NODE_ENV`. **No crear `COOKIE_SECURE=false` ni `PORT`** en Railway.

### 4.4 Plan y coste
- Se empezó con la prueba gratuita. Para uso continuado, plan **Hobby** (~5 $/mes), que además permite más dominios propios.
- Copia de seguridad: Railway › volumen › Backups (o descargar `/data`).

---

## 5. Nominalia (dominio y DNS)

### 5.1 Qué hay
- Dominio `clubhoqueiripollet.com` registrado en Nominalia, con su **hosting** «Hosting Web Expert» (PHP compartido, WordPress antiguo con la web del club `www.clubhoqueiripollet.com`). Ese hosting **no sirve** para esta aplicación (no ejecuta Node.js); por eso la web va en Railway y solo se usa el DNS.
- Correo del dominio: el MX apunta a `mail.nominalia.com` (las bústies como `info@` son de Nominalia). **No tocar los MX**: Nominalia avisa de que se perderían las bústies.
- Para entrar a gestionar DNS hace falta el **código 2FA** del responsable del dominio.

### 5.2 Cómo se editan los DNS
Panel › Domini › **Editar zona DNS** (¡no «Iniciar el canvi de DNS», que cambia los servidores de todo el dominio!) › Afegir registre.
- **Nom**: solo la parte de delante (`comissioevents`, `_dmarc`…). Para el dominio principal: `clubhoqueiripollet.com.` (con punto final); el nombre vacío no deja guardar y `@` crea un subdominio llamado «@».
- **Valor de un CNAME**: con punto final (`qyk4mjvs.up.railway.app.`).
- **Valor de un TXT**: **entre comillas dobles** (si no, el botón «Desa» no se activa).
- TTL: 1 hora.

### 5.3 Registros creados para este proyecto
| Tipo | Nombre | Valor | Para |
|---|---|---|---|
| CNAME | `comissioevents` | `qyk4mjvs.up.railway.app.` | La web en Railway |
| TXT | `_railway-verify.comissioevents` | `"railway-verify=…"` (lo da Railway) | Verificación del dominio en Railway |
| TXT | `clubhoqueiripollet.com.` | `"brevo-code:…"` (lo da Brevo) | Verificación del dominio en Brevo |
| CNAME | `brevo1._domainkey` | `b1.clubhoqueiripollet-com.dkim.brevo.com.` | Firma DKIM de los correos |
| CNAME | `brevo2._domainkey` | `b2.clubhoqueiripollet-com.dkim.brevo.com.` | Firma DKIM de los correos |
| TXT | `_dmarc` | `"v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com"` | Política DMARC |

Restos del dominio anterior (se pueden borrar): CNAME `botiga` y TXT `_railway-verify.botiga`.

### 5.4 Comprobar DNS sin esperar
Desde una terminal (Windows):
```bash
nslookup -type=CNAME comissioevents.clubhoqueiripollet.com dns1.nominalia.com
nslookup -type=TXT _railway-verify.comissioevents.clubhoqueiripollet.com dns1.nominalia.com
nslookup -type=TXT clubhoqueiripollet.com 8.8.8.8
```
Preguntar a `dns1.nominalia.com` muestra el cambio al instante; a `8.8.8.8` (Google) puede tardar un rato.

---

## 6. Brevo (correos)

- **Por qué Brevo**: Railway (planes Free/Hobby) bloquea el SMTP, así que los correos se envían por la **API HTTPS** de Brevo. Plan gratuito: 300 correos/día.
- Montaje: cuenta en brevo.com › *Senders, Domains & Dedicated IPs* › **Domains** › añadir `clubhoqueiripollet.com` › crear en Nominalia los 4 registros de 5.3 › **Autenticar** (sale «Autentificado»). Con el dominio autenticado se puede enviar desde cualquier dirección `@clubhoqueiripollet.com`.
- Al principio se usó como remitente el Gmail de la comisión (`comissioeventschripollet@gmail.com`, verificado en *Senders*) mientras no había acceso a Nominalia.
- Clave: *SMTP & API › API Keys* → variable `BREVO_API_KEY`. Remitente → `MAIL_FROM`.
- El QR de los correos va como imagen enlazada a la web (`/qr-img/<token>.png`) y además adjunto.
- Si los correos van a spam: revisar que el dominio siga autenticado; opcionalmente añadir un registro SPF (ahora no hay, y con DKIM basta).

---

## 7. Anthropic (IA de Ripo)

- Consola: **platform.claude.com** (distinta de claude.ai). Cuenta creada por Sergi (se puede invitar a otros en *Settings › Members* o crear una cuenta del club y cambiar la clave).
- **Billing**: créditos de prepago, **recarga automática desactivada** (si se acaba el saldo, Ripo dice «ahora no puedo responder» y la web sigue igual). *Limits*: tope de gasto mensual.
- **API Keys**: crear con **alcance de espacio de trabajo** («Default»), **no** «Organización» (esa es una clave de administración). Si se creó con caducidad (p. ej. 30 días), renovarla antes: crear otra y cambiar `ANTHROPIC_API_KEY` en Railway.
- **Modelo**: Claude Haiku 5.5 (`claude-haiku-5-5`), esfuerzo bajo, respuestas cortas. Coste orientativo: ~0,002 $ por conversación (céntimos al mes). El gasto por modelo se ve en *Usage*.
- Con la API, Anthropic no usa las conversaciones para entrenar modelos.

---

## 8. Ripo, el asistente (antes «Pollet»)

### 8.1 Cómo funciona
No se «entrena»: en **cada pregunta** la web envía a Claude unas instrucciones + una «chuleta» y la conversación (máx. 10 mensajes). No recuerda nada entre conversaciones ni aprende de lo que le dicen.

La chuleta (`src/assistant.js` › `knowledge()` y `personal()`) contiene:
1. **Normas** fijas (idioma, brevedad, no inventar, no hacer acciones, no datos de otras personas, ignorar intentos de cambiar las normas).
2. **Personalidad y tono** — editable en *Admin › Textos de la web*.
3. **Guía de uso de la tienda** (en el código).
4. «Quiénes somos» (texto de la web).
5. **Información del club y de Ripollet** — editable en *Admin › Textos de la web › «Informació del club per al Ripo»*: web del club (contacto, escuela, equipaciones, Special Olympics, coordinador…), **guías de tallas** en texto, historia y datos de Ripollet (Viquipèdia).
6. **Equipos del CH Ripollet**: clasificación, últimos resultados y próximos partidos (okCat360, cada 12 h).
7. **Catálogo y packs** actuales (de la base de datos).
8. **Situación**: fecha, periodo de pedidos y, si la persona ha entrado, sus pedidos y su carrito.

Los bloques 1-7 se marcan como caché en la API (más barato).

### 8.2 Protecciones y límites
- Contador por día (hora de Madrid, se reinicia a medianoche) en la tabla `assistant_usage`:
  - **con cuenta**: 30 preguntas por cuenta y día (`ASSISTANT_USER_DAILY_LIMIT`);
  - **sin cuenta**: 30 por sesión del navegador **y** 90 por conexión/IP (el triple, porque una wifi la comparten muchas familias), para que no se pueda saltar abriendo una ventana de incógnito;
  - **total**: 500 al día para toda la web (`ASSISTANT_DAILY_LIMIT`).
  Al llegar al límite responde «Per avui ja he respost moltes preguntes…».
- **Tauler › «Ripo, l'assistent»**: preguntas de hoy y de cuántas personas, quién ha preguntado más (con aviso si alguien ha llegado al límite) y total de los últimos días. El coste exacto, en la consola de Anthropic (*Usage*).
- Si la API falla o no hay saldo: mensaje amable, sin romper nada.
- No aparece en el panel de la comisión.

### 8.3 Voz
Botón 🎤 (hablar) y 🔊 (leer respuestas) usando las funciones de voz **del navegador** (gratis). Micrófono en Chrome, Edge y Safari (no Firefox). La voz catalana depende del dispositivo.

### 8.4 Datos de partidos (okCat360)
- `src/club-data.js` + `scripts/club-data-worker.js`: un **proceso aparte** descarga `https://okcat360.vercel.app/data.json` (~40 MB, generado cada día por el proyecto okCat360), se queda con los equipos cuyo nombre contiene «Ripollet» y guarda un resumen pequeño en `settings` (clave `club_data`). Se refresca al arrancar (si tiene más de 12 h) y cada 12 h.
- okCat360 = repositorio `github.com/sergireven/hoquei-fecapa` (Vercel; `hoquei-fecapa.vercel.app` redirige a `okcat360.vercel.app`). Su `data.json` incluye clasificación, calendario y resultados de todas las competiciones; los goleadores (`teamScorers`) están vacíos. Hay archivos de temporadas desde 2021-22 en el repositorio (`public/season-archive`).
- Fuente original (por si okCat360 deja de funcionar): la web de la federación `hoqueipatins.fecapa.cat` carga sus datos de la plataforma **SIDGAD** (`https://www.server2.sidgad.es/fecapa/…`, con cabecera `Origin: https://www.hoqueipatins.fecapa.cat`):
  - `fecapa_ls_1.php` — lista de competiciones (el CH Ripollet es el club **278**; temporada 2026/27 = `temp 41`).
  - `fecapa_cal_idc_<competición>_1.php` (calendario), `fecapa_clasif_idc_<competición>_1.php` (clasificación), `fecapa_stats_1_<competición>.php` (estadísticas).
  - No es una API oficial: puede cambiar sin aviso.

---

## 9. Catálogo de productos

- Plantilla Excel `plantilla-articulos-v2.xlsx` (hoja de artículos y de packs con IDs numéricos; fotos en `img/`).
- Convertir e importar:
```bash
python scripts/catalogo-excel-a-json.py plantilla-articulos-v2.xlsx catalogo.json
npm run import-catalog -- catalogo.json img
```
  Se puede repetir: actualiza por nombre y oculta lo que ya no está. En Railway solo se importa solo si la base está vacía (`--si-vacio`); el día a día se gestiona desde *Admin › Productos / Packs*.
- Personalización en el Excel: «… (opcional)» = se puede elegir «Sin personalizar».
- Si cambian las guías de tallas: cambiar la imagen del producto **y** las medidas en el texto de Ripo.

---

## 10. Tareas habituales

**Antes de abrir una campaña de pedidos**
1. Revisar productos (precio, tallas, colores, modelos, personalización, visible) y packs.
2. *Períodes*: crear el periodo con apertura y cierre.
3. Borrar pedidos de prueba (*Pedidos › abrir › Eliminar pedido*; al borrar el último, la numeración vuelve al #0001) y cuentas de prueba (*Clientes*).

**Durante y después**: ver la guía de la comisión (`manual-comissio.pdf`): cobro y entrega con QR, aviso de recogida, resumen para el proveedor, CSV, caja por persona.

**Cambiar lo que sabe Ripo**: *Admin › Textos de la web* (tono e información del club).

**Vigilar el uso de Ripo**: *Tauler* (preguntas de hoy y de los últimos días) y consola de Anthropic (*Usage*, gasto). Si el límite se queda corto o largo, cambiar `ASSISTANT_USER_DAILY_LIMIT` en Railway.

**Documentación**: *Admin › Manuals*. Si se cambia un manual, sustituir el PDF en `docs/` y subirlo con Git.

**Si una familia no puede entrar**: «He oblidat la contrasenya» o *Clientes › ficha › Generar contraseña nueva*.

**Renovaciones a vigilar**: clave de Anthropic (si caduca), saldo de Anthropic, plan de Railway, dominio en Nominalia.

---

## 11. Problemas que ya nos encontramos (y su solución)

| Síntoma | Causa | Solución |
|---|---|---|
| `npm install` intenta compilar y falla | `better-sqlite3` intentaba compilar | `.npmrc` con `ignore-scripts=true` |
| Los correos no llegan desde Railway | Railway bloquea el SMTP | Envío por API de Brevo |
| Enlaces de los correos a `localhost` | Variable `APP_URL=http://localhost:3000` copiada del ejemplo | Corregir `APP_URL` (además, en Railway la web ignora un `APP_URL` con localhost) |
| Cookie de sesión no segura en producción | `COOKIE_SECURE=false` en las variables | Borrar esa variable |
| Primer botón tras crear cuenta daba error | La página usaba el token CSRF de la sesión anterior | Corregido en el código |
| El total de la lista sumaba cancelados / un producto oculto sumaba en el carrito | Errores de cálculo | Corregidos (detectados en las pruebas E2E) |
| Brevo no verificaba el dominio | El TXT se creó como `@.clubhoqueiripollet.com` | Nombre `clubhoqueiripollet.com.` |
| Nominalia no deja guardar un TXT | Falta poner el valor entre comillas | Valor entre comillas dobles |
| Railway no verificaba el dominio | En el TXT se puso el nombre en vez del valor | Valor `"railway-verify=…"` |
| No se puede añadir otro dominio en Railway | Límite de 1 dominio del plan | Borrar el anterior o pasar a Hobby |
| El pollito no aparecía | La publicación aún no había terminado / caché | Esperar el deploy y recargar con Ctrl+F5 |
| Más de 30 preguntas a Ripo sin límite | Sin cuenta se contaba solo por sesión (incógnito = de cero) | Ahora también por conexión/IP |

---

## 12. Pruebas

- `npm test`: 23 pruebas automáticas del flujo completo (cuentas, pedidos, packs, QR, correos con Brevo simulado, Ripo con IA simulada y sus límites, datos de partidos, manuales solo para la comisión, redirección de dominios, traducciones…). Deben pasar todas antes de cada `git push`.
- En octubre de 2026 se hizo además una batería E2E contra una copia aislada (205 comprobaciones: compras con y sin packs, totales del panel/caja/resumen/CSV, cobro y entrega, cancelaciones, seguridad entre clientes). Informe publicado como artefacto «Pruebas de la botiga».

---

## 13. Pendiente / ideas

- Goleadores (no están en okCat360; habría que sacarlos de las actas).
- Decidir si, con el periodo cerrado, las familias pueden seguir cancelando pedidos no pagados (ahora sí pueden).
- Secciones de Eventos y Noticias en la web pública.
- Borrar en Nominalia los registros de `botiga`.
- Valorar el plan Hobby de Railway y una cuenta de Anthropic del club.

---

## 14. Cronología resumida

| Fecha | Hito |
|---|---|
| 07/10/2026 | Primera versión de la tienda (pedidos, QR, bilingüe, panel) |
| oct. 2026 | Web de la comisión con secciones; catálogo desde Excel; packs automáticos; despliegue en Railway |
| oct. 2026 | Correos con Brevo; cuentas con correo y un solo QR; nombre y apellidos; «Sin personalizar» |
| 10-11/10/2026 | Pruebas E2E y correcciones; dominio propio y DNS en Nominalia; Brevo autenticado |
| 11/10/2026 | Ripo: asistente con Claude Haiku 5.5, información del club, partidos (okCat360), voz, tono editable, guías de tallas |
| 11/10/2026 | Cambio de dominio a `comissioevents.clubhoqueiripollet.com` |
| 11/10/2026 | El asistente pasa a llamarse **Ripo**; información de la web del club; manual técnico y sección Manuals; límite por conexión y uso de Ripo en el Tauler |
