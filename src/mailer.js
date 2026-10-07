const nodemailer = require('nodemailer');
const { formatMoney, orderCode, STATUS } = require('./util');

const CLUB = process.env.CLUB_NAME || 'Club Hoquei Ripollet';

function createMailer(db) {
  const configured = Boolean(process.env.SMTP_HOST);
  const transport = configured
    ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
    // Sin SMTP configurado los correos no salen: solo se guardan en el registro de emails (útil en pruebas).
    : nodemailer.createTransport({ jsonTransport: true });
  const from = process.env.MAIL_FROM || `${CLUB} <no-reply@example.com>`;
  const log = db.prepare('INSERT INTO email_log (to_address, subject, body, status, error) VALUES (?, ?, ?, ?, ?)');

  /** Envía en segundo plano: un fallo de correo nunca bloquea la acción del usuario. */
  function send(to, subject, text) {
    if (!to) return Promise.resolve();
    const fullSubject = `[${CLUB}] ${subject}`;
    const body = `${text}\n\n—\n${CLUB} · Comisión de marxandatge\nEste es un correo automático.`;
    // En el registro nunca se guardan contraseñas ni enlaces de recuperación.
    const logged = body.replace(/(Contraseña: |contraseña es: )\S+/g, '$1••••••').replace(/\/recuperar\/[0-9a-f]+/g, '/recuperar/••••••');
    return transport.sendMail({ from, to, subject: fullSubject, text: body })
      .then(() => log.run(to, fullSubject, logged, configured ? 'enviado' : 'simulado', null))
      .catch((err) => {
        console.error('[mail] error enviando a', to, err.message);
        log.run(to, fullSubject, logged, 'error', err.message);
      });
  }

  const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;

  function itemsText(items) {
    return items.map((it) => {
      const extras = [it.size && `talla ${it.size}`, it.custom_name && `nombre "${it.custom_name}"`, it.custom_number && `dorsal ${it.custom_number}`]
        .filter(Boolean).join(', ');
      return `  · ${it.quantity} x ${it.product_name}${extras ? ` (${extras})` : ''} — ${formatMoney(it.unit_price_cents * it.quantity)}`;
    }).join('\n');
  }

  return {
    send,

    accountActivated(user, password, appUrl) {
      return send(user.email, 'Tu acceso a la tienda del club',
        `Hola,\n\nSe ha activado la cuenta de la tienda para ${user.player_name || user.dni}.\n\n`
        + `Usuario (DNI): ${user.dni}\nContraseña: ${password}\n\n`
        + `Entra en ${appUrl}/login\nGuarda este correo: necesitarás la contraseña para volver a entrar.`);
    },

    resetLink(user, link) {
      return send(user.email, 'Recuperar acceso',
        `Hola,\n\nHemos recibido una solicitud para recuperar el acceso de ${user.player_name || user.dni || user.username}.\n\n`
        + `Usuario: ${user.dni || user.username}\n\nPara generar una contraseña nueva abre este enlace (válido 1 hora):\n${link}\n\n`
        + 'Si no lo has pedido tú, ignora este correo: tu contraseña actual sigue funcionando.');
    },

    newPassword(user, password) {
      return send(user.email, 'Tu nueva contraseña',
        `Hola,\n\nTu nueva contraseña es: ${password}\nUsuario: ${user.dni || user.username}`);
    },

    orderPlaced(user, order, items, appUrl) {
      const text = `Hola,\n\nHemos recibido el pedido ${orderCode(order.id)} de ${user.player_name || user.dni}.\n\n`
        + `${itemsText(items)}\n\nTotal a pagar: ${formatMoney(order.total_cents)}\n\n`
        + 'Estado: PENDIENTE DE PAGO. El pago se hace en mano a la comisión. '
        + 'Mientras no esté pagado puedes cancelarlo desde la web.\n\n'
        + `Consulta tus pedidos en ${appUrl}/pedidos`;
      send(user.email, `Pedido ${orderCode(order.id)} recibido`, text);
      if (adminEmail) {
        send(adminEmail, `Nuevo pedido ${orderCode(order.id)} · ${user.player_name || user.dni}`,
          `${itemsText(items)}\n\nTotal: ${formatMoney(order.total_cents)}\n${appUrl}/admin/pedidos/${order.id}`);
      }
    },

    statusChanged(user, order, appUrl) {
      const messages = {
        pendiente_entrega: `Hemos recibido el pago de ${formatMoney(order.total_cents)}. ¡Gracias!\n\n`
          + 'Ahora el pedido está PENDIENTE DE ENTREGA. Cuando lo recojas, enseña a la comisión el código QR '
          + `(o el código de entrega) que encontrarás en ${appUrl}/pedidos/${order.id}`,
        entregado: 'El pedido se ha marcado como ENTREGADO. ¡Que lo disfrutéis! Si hay algún problema, habla con la comisión.',
        cancelado: 'El pedido se ha CANCELADO.',
        pendiente_pago: `El pedido vuelve a estar PENDIENTE DE PAGO (${formatMoney(order.total_cents)}).`,
      };
      send(user.email, `Pedido ${orderCode(order.id)}: ${STATUS[order.status].label}`,
        `Hola,\n\n${messages[order.status]}\n\nPedido ${orderCode(order.id)} · ${user.player_name || user.dni}`);
      if (adminEmail && order.status === 'cancelado') {
        send(adminEmail, `Pedido ${orderCode(order.id)} cancelado · ${user.player_name || user.dni}`,
          `${appUrl}/admin/pedidos/${order.id}`);
      }
    },
  };
}

module.exports = { createMailer };
