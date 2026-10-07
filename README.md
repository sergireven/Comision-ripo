# Botiga · Club Hoquei Ripollet

Web en **català i castellano** (selector CA/ES arriba a la derecha; los correos llegan en el idioma de cada familia).

Web para gestionar los pedidos de marxandatge del club (camisetas, sudaderas, bufandas, botelleros…).
El pago se hace en mano a la comisión. La web controla qué ha pedido cada familia, cuánto debe y en qué estado está cada pedido, y envía correos de confirmación en cada paso.

## Qué hace

**Familias** (usuario = DNI del jugador/a)
- **Primer acceso** (solo para cuentas que la comisión ya ha dado de alta sin correo): la familia introduce el DNI → indica el correo de contacto → la web genera una contraseña única (tipo `RIPO-K7QM-3XTA`), la muestra en pantalla y la envía por correo.
- **Recuperar acceso**: se envía un enlace (válido 1 h y de un solo uso) al correo de la cuenta para generar una contraseña nueva.
- **Tienda** con desplegable por tipo de producto, foto, precio, cantidad y talla. Los productos marcados como «nombre + dorsal» (p. ej. el botellero) piden ambos datos (se rellenan solos con los del jugador/a).
- **Carrito** → revisar → «Realizar pedido». El pedido queda **pendiente de pago** y se puede cancelar mientras no esté pagado.
- **Mis pedidos**: todos los pedidos con su estado, el importe pendiente y el historial.
- Al hacer el pedido recibe por correo el **QR de pago**. Al pagar, recibe el **comprobante** y el **QR de recogida** (también visibles en «Mis pedidos»).
- Barra superior con el periodo de pedidos y la **cuenta atrás hasta el cierre**.

**Comisión (admin)**
- **Panel**: pedidos por estado, dinero cobrado y pendiente de cobrar, familias activadas.
- **Pedidos**: filtros por estado, periodo y búsqueda (nombre, DNI, correo, nº de pedido); botón rápido «Marcar pagado»; exportación a Excel (CSV); historial de cada pedido con quién hizo cada cambio.
- **Escanear**: lector de QR dentro de la propia web (cámara del móvil) o con la cámara normal del móvil. Ver «Pago y entrega con QR».
- **Caja por persona**: cuánto ha cobrado cada miembro de la comisión, para cuadrar el dinero en mano.
- **Aviso «listo para recoger»**: cuando llega el material, un botón envía a todas las familias pagadas un correo con su QR de recogida y un mensaje (día, hora y lugar).
- **Resumen** para el proveedor: unidades por producto y talla, más el listado de personalizaciones (nombre y dorsal). Imprimible.
- **Productos** (nombre y descripción en castellano y, opcionalmente, en catalán; foto, precio, categoría, tallas, «requiere nombre + dorsal», visible/oculto) y **categorías**.
- **Periodos de pedidos**: fechas de apertura y cierre (hora de Madrid). Fuera de un periodo no se puede añadir al carrito ni confirmar pedidos.
- **Familias** (solo la comisión puede dar de alta usuarios): alta individual o importación pegando desde Excel (`DNI;Nombre;Dorsal;Equipo;Correo`). Si se indica el correo, la cuenta queda activada y la familia recibe su contraseña por correo; si no, la familia hace el «Primer acceso» con el DNI. Desde la ficha se puede enviar una contraseña nueva, editar los datos o reiniciar el acceso.
- **Administradores** y **registro de correos** enviados (sin contraseñas).

### Pago y entrega con QR

```
Familia hace el pedido ──▶ correo con QR DE PAGO
        │
Paga en mano ──▶ la comisión escanea el QR de pago ──▶ «Cobrado» (queda registrado quién cobra)
        │                                               └──▶ correo: COMPROBANTE + QR DE RECOGIDA
Llega el material ──▶ la comisión pulsa «Avisar: listo para recoger» ──▶ correo a todas las familias pagadas
        │
Recoge ──▶ la comisión escanea el QR de recogida ──▶ «Confirmar entrega» ──▶ correo de entregado
```

- Cada QR solo sirve para su paso: con el QR de pago no se puede entregar y el de recogida no existe hasta que se paga.
- El QR solo funciona con la sesión de la comisión iniciada: si una familia lo abre, no puede cambiar nada.
- Si se deshace un cobro, el QR de recogida anterior deja de valer.
- Plan B sin móvil: cobrar buscando el pedido por nombre; entregar tecleando el código de recogida de 6 caracteres; o, en último caso, marcar como entregado indicando el motivo (queda registrado).
- El lector de QR dentro de la web necesita HTTPS (cualquier hosting lo da).

### Estados de un pedido

```
pendiente de pago ──(la comisión cobra)──▶ pagado · pendiente de entrega ──(QR / código)──▶ entregado
        │
        └──(la familia o la comisión cancela)──▶ cancelado
```
Si la comisión se equivoca, puede deshacer un paso. Cada cambio queda en el historial y se avisa por correo a la familia.

### Correos automáticos
Activación de cuenta, recuperación de contraseña, pedido recibido, pago registrado (con el enlace al QR), pedido entregado y pedido cancelado.
Si se define `ADMIN_NOTIFY_EMAIL`, la comisión recibe un aviso de cada pedido nuevo o cancelado.

## Puesta en marcha

Requisitos: Node.js 20 o superior.

```bash
npm install
cp .env.example .env        # y edítalo (SESSION_SECRET, APP_URL, SMTP…)
npm start                   # http://localhost:3000
```

**Primer administrador**: define `ADMIN_USER` y `ADMIN_PASSWORD` (mín. 10 caracteres) en el `.env` o en las variables del hosting y se crea solo al arrancar. También se puede crear con `npm run create-admin -- usuario "contraseña" correo`. El resto de la comisión se da de alta desde *Administradores*.

Para probarlo con datos de ejemplo: `npm run seed-demo` (admin `comision` / `comision-demo` y DNIs `12345678Z`, `87654321X`, `X1234567L`).

Primeros pasos en la web: **Familias** → importar el listado de jugadores · **Productos** → crear los artículos con foto · **Periodos** → abrir un periodo de pedidos.

### Correo
Sin `SMTP_HOST` los correos no se envían (solo se registran en *Admin › Correos*). Con Gmail: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, el usuario de la cuenta y una [contraseña de aplicación](https://myaccount.google.com/apppasswords). Para muchos envíos es mejor un servicio como Brevo, Mailgun o SendGrid (todos dan datos SMTP).

### Despliegue
Es una app Node con la base de datos SQLite en `data/club.db` y las fotos en `uploads/`, así que necesita un hosting con **disco persistente** (un VPS, o Railway/Render/Fly.io con volumen). En producción hay que usar HTTPS y poner `COOKIE_SECURE=true` (y `TRUST_PROXY=1` si va detrás de un proxy). Para hacer una copia de seguridad basta con copiar `data/` y `uploads/`.

## Desarrollo

```bash
npm run dev   # recarga al guardar
npm test      # pruebas del flujo completo
```

Estructura: `src/` (servidor Express, rutas, base de datos, correos), `views/` (plantillas EJS), `public/` (CSS, JS, logo).
Las votaciones de diseños se podrán añadir como una sección nueva reutilizando las cuentas de familias existentes.

## Seguridad
- Contraseñas guardadas con bcrypt; los enlaces de recuperación se guardan como hash y caducan.
- Protección CSRF en todos los formularios, cookies `httpOnly` y límite de intentos en el login, el primer acceso y la recuperación.
- Solo se pueden activar los DNI que la comisión ha dado de alta.
- **Limitación conocida**: quien conozca el DNI de un jugador/a cuya cuenta aún no se haya activado podría activarla antes que la familia. Si pasa, la comisión puede usar «Reiniciar acceso» desde la ficha de la familia. Si se quiere más seguridad, se puede añadir un código de activación que reparta la comisión.
