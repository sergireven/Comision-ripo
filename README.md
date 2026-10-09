# Botiga · Club Hoquei Ripollet

Web en **català i castellano** (selector CA/ES arriba a la derecha; los correos llegan en el idioma de cada persona).

Web de la comisión de eventos del club con la tienda de marxandatge (camisetas, sudaderas, bufandas, botellas…).
El pago se hace en mano a la comisión. La web controla qué ha pedido cada persona, cuánto debe y en qué estado está cada pedido, y envía correos de confirmación en cada paso.

## Qué hace

**Clientes** (cualquiera puede comprar: usuario = su correo)
- **Crear cuenta** con nombre y apellidos y el correo: la web genera una contraseña (tipo `RIPO-K7QM-3XTA`), la muestra en pantalla y la envía por correo. Un correo = una cuenta.
- **Recuperar acceso**: se envía un enlace (válido 1 h y de un solo uso) al correo para generar una contraseña nueva.
- **Tienda** con desplegable por tipo de producto, packs, foto, precio, color/modelo, talla y cantidad. Los productos marcados como «nombre jugador + dorsal» piden ambos datos.
- **Carrito** → revisar → «Realizar pedido». El pedido queda **pendiente de pago** y se puede cancelar mientras no esté pagado.
- **Mis pedidos**: todos los pedidos con su estado, el importe pendiente, el historial y el **QR del pedido**.
- Al hacer el pedido recibe por correo el **QR del pedido**, que sirve para pagar y para recoger. Al pagar recibe el **comprobante**, que vuelve a llevar el QR.
- Barra superior con el periodo de pedidos y la **cuenta atrás hasta el cierre**.

**Comisión (admin)**
- **Panel**: pedidos por estado, dinero cobrado y pendiente de cobrar, clientes registrados.
- **Pedidos**: filtros por estado, periodo y búsqueda (correo o nº de pedido); botones rápidos «Marcar pagado» y «Marcar entregado»; exportación a Excel (CSV); historial de cada pedido con quién hizo cada cambio.
- **Escanear**: lector de QR dentro de la propia web (cámara del móvil) o con la cámara normal del móvil. Ver «Pago y entrega con QR».
- **Caja por persona**: cuánto ha cobrado cada miembro de la comisión, para cuadrar el dinero en mano.
- **Aviso «listo para recoger»**: cuando llega el material, un botón envía a todos los pedidos pagados un correo con su QR y un mensaje (día, hora y lugar).
- **Resumen** para el proveedor: unidades por producto, color/modelo y talla, más el listado de personalizaciones (nombre jugador y dorsal). Imprimible.
- **Productos** (nombre y descripción en castellano y, opcionalmente, en catalán; foto, precio, categoría, colores, modelos, tallas, guía de tallas, «requiere nombre jugador + dorsal», visible/oculto), **categorías** y **packs**.
- **Periodos de pedidos**: fechas de apertura y cierre (hora de Madrid). Fuera de un periodo no se puede añadir al carrito ni confirmar pedidos.
- **Clientes**: lista de cuentas con nombre y correo (la comisión no crea usuarios: cada persona se da de alta). Desde la ficha se puede corregir el nombre, generar una contraseña nueva (se envía por correo; sin servicio de correo se muestra a la comisión) o eliminar una cuenta sin pedidos.
- **Textos de la web**, **administradores** y **registro de correos** enviados (sin contraseñas).

### Pago y entrega con QR

Cada pedido tiene **un único QR**:

```
Hace el pedido ──▶ correo con el QR DEL PEDIDO
        │
Paga en mano ──▶ la comisión escanea el QR ──▶ «Cobrado» (queda registrado quién cobra) ──▶ correo: COMPROBANTE (con el mismo QR)
        │
Llega el material ──▶ «Avisar: listo para recoger» ──▶ correo (con el mismo QR) a todos los pedidos pagados
        │
Recoge ──▶ la comisión escanea el MISMO QR ──▶ «Confirmar entrega» ──▶ correo de entregado
```

- Al escanear, la web ofrece lo que toca según el estado: cobrar si está pendiente de pago, entregar si ya está pagado.
- El QR solo funciona con la sesión de la comisión iniciada: si un cliente lo abre, no puede cambiar nada.
- Sin QR: buscar el pedido por correo o número en «Pedidos» y usar «Marcar pagado» o «Marcar entregado» (queda registrado).
- El lector de QR dentro de la web necesita HTTPS (cualquier hosting lo da).

### Estados de un pedido

```
pendiente de pago ──(la comisión cobra)──▶ pagado · pendiente de entrega ──(QR o a mano)──▶ entregado
        │
        └──(el cliente o la comisión cancela)──▶ cancelado
```
Si la comisión se equivoca, puede deshacer un paso. Cada cambio queda en el historial y se avisa por correo.

### Correos automáticos
Cuenta creada, recuperación de contraseña, pedido recibido (con el QR), pago registrado (comprobante, con el QR), aviso de recogida (con el QR), pedido entregado y pedido cancelado.
Si se define `ADMIN_NOTIFY_EMAIL`, la comisión recibe un aviso de cada pedido nuevo o cancelado.

### Colores, opciones y packs
- Cada producto puede tener **colores** y **opciones** (p. ej. «Escudo, Pollito») separados por comas: la familia elige uno al comprar. Con un solo valor se asigna sin preguntar. También puede llevar una **guía de tallas** (imagen).
- **Packs** (*Admin › Packs*): varios productos a un precio especial; algunos pueden ir **de regalo**.
- En el carrito los packs se aplican solos con la combinación que más ahorra, tanto si la familia añade el pack entero como si añade los productos por separado (2 camisetas + 2 bufandas = 2 packs). Se ve el pack aplicado, los productos de cada pack y el descuento.
- En el pedido el descuento queda como una línea en negativo y los regalos como líneas a 0 €, así el total, los correos, el CSV y la caja cuadran. El *Resumen* para el proveedor cuenta los regalos como unidades.

### Cargar el catálogo desde Excel
La plantilla `plantilla-articulos-v2.xlsx` tiene una hoja de artículos y otra de packs (con IDs numéricos). Las fotos van en la carpeta `img/`.

```bash
python scripts/catalogo-excel-a-json.py plantilla-articulos-v2.xlsx catalogo.json   # necesita openpyxl
npm run import-catalog -- catalogo.json img
```
Se puede repetir: los artículos y packs se actualizan por nombre y los productos que ya no están en el Excel se ocultan (no se borran).

## Puesta en marcha

Requisitos: Node.js 22 o superior.

```bash
npm install
cp .env.example .env        # y edítalo (SESSION_SECRET, APP_URL, SMTP…)
npm start                   # http://localhost:3000
```

**Primer administrador**: define `ADMIN_USER` y `ADMIN_PASSWORD` (mín. 10 caracteres) en el `.env` o en las variables del hosting y se crea solo al arrancar. También se puede crear con `npm run create-admin -- usuario "contraseña" correo`. El resto de la comisión se da de alta desde *Administradores*.

Para probarlo con datos de ejemplo: `npm run seed-demo` (admin `comision` / `comision-demo` y cliente `familia@example.com` / `familia-demo`).

Primeros pasos en la web: **Productos** → crear los artículos con foto (o cargar el catálogo desde Excel) · **Periodos** → abrir un periodo de pedidos. Los clientes se dan de alta solos con su correo.

### Correo
Sin servicio de correo los correos no se envían (solo se registran en *Admin › Correos*); al crear una cuenta la contraseña solo se ve en pantalla.

**Brevo (recomendado, obligatorio en Railway Free/Hobby, que bloquea el SMTP):** crea una cuenta gratuita en brevo.com (300 correos/día), verifica el correo remitente (*Senders*), crea una clave API (*SMTP & API › API Keys*) y define `BREVO_API_KEY` y `MAIL_FROM=Comissió HC Ripollet <correo-verificado@…>`. El QR va como imagen enlazada a la web (`/qr-img/…`) y además adjunto.

**SMTP:** si no hay `BREVO_API_KEY`, se usa `SMTP_HOST`. Con Gmail: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, el usuario de la cuenta y una [contraseña de aplicación](https://myaccount.google.com/apppasswords). Para muchos envíos es mejor un servicio como Brevo, Mailgun o SendGrid (todos dan datos SMTP).

### Despliegue
Es una app Node con la base de datos SQLite en `data/club.db` y las fotos en `uploads/`, así que necesita un hosting con **disco persistente** (un VPS, o Railway/Render/Fly.io con volumen). En producción hay que usar HTTPS y poner `COOKIE_SECURE=true` (y `TRUST_PROXY=1` si va detrás de un proxy). Para hacer una copia de seguridad basta con copiar `data/` y `uploads/`.

## Desarrollo

```bash
npm run dev   # recarga al guardar
npm test      # pruebas del flujo completo
```

Estructura: `src/` (servidor Express, rutas, base de datos, correos), `views/` (plantillas EJS), `public/` (CSS, JS, logo).
Las votaciones de diseños se podrán añadir como una sección nueva reutilizando las cuentas de clientes existentes.

## Seguridad
- Contraseñas guardadas con bcrypt; los enlaces de recuperación se guardan como hash y caducan.
- Protección CSRF en todos los formularios, cookies `httpOnly` y límite de intentos en el login, el alta y la recuperación.
- Un correo = una cuenta. Las contraseñas generadas se muestran una vez en pantalla y se envían por correo; nunca se guardan en claro ni en el registro de correos.
- **A tener en cuenta**: como la contraseña sale en pantalla al darse de alta, alguien podría crear una cuenta con un correo que no es suyo. No da acceso a nada de otra persona; si pasa, la comisión puede eliminar la cuenta (si no tiene pedidos).
