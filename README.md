# Botiga · Club Hoquei Ripollet

Web para gestionar los pedidos de marxandatge del club (camisetas, sudaderas, bufandas, botelleros…).
El pago se hace en mano a la comisión. La web controla qué ha pedido cada familia, cuánto debe y en qué estado está cada pedido, y envía correos de confirmación en cada paso.

## Qué hace

**Familias** (usuario = DNI del jugador/a)
- **Primer acceso**: la familia introduce el DNI → indica el correo de contacto → la web genera una contraseña única (tipo `RIPO-K7QM-3XTA`), la muestra en pantalla y la envía por correo.
- **Recuperar acceso**: se envía un enlace (válido 1 h y de un solo uso) al correo de la cuenta para generar una contraseña nueva.
- **Tienda** con desplegable por tipo de producto, foto, precio, cantidad y talla. Los productos marcados como «nombre + dorsal» (p. ej. el botellero) piden ambos datos (se rellenan solos con los del jugador/a).
- **Carrito** → revisar → «Realizar pedido». El pedido queda **pendiente de pago** y se puede cancelar mientras no esté pagado.
- **Mis pedidos**: todos los pedidos con su estado, el importe pendiente y el historial.
- Cuando el pedido está pagado aparece un **código QR** (y un código de 6 caracteres) para recogerlo.
- Barra superior con el periodo de pedidos y la **cuenta atrás hasta el cierre**.

**Comisión (admin)**
- **Panel**: pedidos por estado, dinero cobrado y pendiente de cobrar, familias activadas.
- **Pedidos**: filtros por estado, periodo y búsqueda (nombre, DNI, correo, nº de pedido); botón rápido «Marcar pagado»; exportación a Excel (CSV); historial de cada pedido con quién hizo cada cambio.
- **Entregar**: al escanear el QR de la familia con la cámara del móvil (con la sesión de la comisión iniciada) se abre el pedido y se confirma la entrega. También se puede teclear el código de 6 caracteres. Si la familia no tiene el QR ni el código, se puede forzar la entrega indicando el motivo (queda registrado). La URL del QR solo funciona para la comisión: una familia no puede marcar su propio pedido como entregado.
- **Resumen** para el proveedor: unidades por producto y talla, más el listado de personalizaciones (nombre y dorsal). Imprimible.
- **Productos** (foto, precio, categoría, tallas, «requiere nombre + dorsal», visible/oculto) y **categorías**.
- **Periodos de pedidos**: fechas de apertura y cierre (hora de Madrid). Fuera de un periodo no se puede añadir al carrito ni confirmar pedidos.
- **Familias**: alta individual o importación pegando desde Excel (`DNI;Nombre;Dorsal;Equipo`), edición de datos y correo, reinicio del acceso.
- **Administradores** y **registro de correos** enviados (sin contraseñas).

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
npm run create-admin -- comision "una-contraseña-larga" comision@ejemplo.com
npm start                   # http://localhost:3000
```

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
