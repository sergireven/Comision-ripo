const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const { formatMoney, orderCode, STATUS } = require('./util');
const { translate, localized, DEFAULT_LANG } = require('./i18n');

const CLUB = process.env.CLUB_NAME || 'Club Hoquei Ripollet';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** «Nombre <correo@x>» -> { name, email } */
function parseAddress(value) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value || '');
  return m ? { name: m[1].replace(/^"|"$/g, '') || undefined, email: m[2].trim() } : { email: String(value || '').trim() };
}

/**
 * Envío por la API HTTPS de Brevo (Railway bloquea el SMTP en los planes Free/Hobby).
 * Brevo no admite imágenes incrustadas (cid): el QR va como imagen enlazada y además adjunto.
 */
function brevoTransport(apiKey, fetchImpl = globalThis.fetch) {
  return {
    async sendMail(mail) {
      const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: parseAddress(mail.from),
          to: [{ email: mail.to }],
          subject: mail.subject,
          textContent: mail.text,
          ...(mail.html ? { htmlContent: mail.html.replace(/cid:qr/g, mail.qrImageUrl || 'cid:qr') } : {}),
          ...(mail.attachments ? {
            attachment: mail.attachments.map((a) => ({ name: a.filename, content: Buffer.from(a.content).toString('base64') })),
          } : {}),
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Brevo ${res.status}: ${detail.slice(0, 300)}`);
      }
    },
  };
}

function createMailer(db, { fetchImpl } = {}) {
  const provider = process.env.BREVO_API_KEY ? 'brevo' : process.env.SMTP_HOST ? 'smtp' : null;
  let transport;
  if (provider === 'brevo') {
    transport = brevoTransport(process.env.BREVO_API_KEY, fetchImpl);
  } else if (provider === 'smtp') {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  } else {
    // Sin servicio de correo los correos no salen: solo se guardan en el registro de emails (útil en pruebas).
    transport = nodemailer.createTransport({ jsonTransport: true });
  }
  const configured = Boolean(provider);
  const from = process.env.MAIL_FROM || `${CLUB} <no-reply@example.com>`;
  const log = db.prepare('INSERT INTO email_log (to_address, subject, body, status, error) VALUES (?, ?, ?, ?, ?)');
  const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;
  const adminLang = process.env.ADMIN_LANG || DEFAULT_LANG;

  /**
   * Envía en segundo plano: un fallo de correo nunca bloquea la acción del usuario.
   * Con `qr` (URL) se adjunta la imagen del código QR dentro del correo.
   */
  async function send(to, subject, text, { lang = DEFAULT_LANG, qr, qrCaption } = {}) {
    if (!to) return;
    const t = (k, p) => translate(lang, k, p);
    const fullSubject = `[${CLUB}] ${subject}`;
    const footer = `—\n${CLUB} · ${t('Comisión de marxandatge')}\n${t('Este es un correo automático.')}`;
    const body = `${text}\n\n${footer}`;
    // En el registro nunca se guardan contraseñas ni enlaces de recuperación.
    const logged = body.replace(/(Contraseña: |Contrasenya: )\S+/g, '$1••••••').replace(/\/recuperar\/[0-9a-f]+/g, '/recuperar/••••••');
    try {
      const mail = { from, to, subject: fullSubject, text: body };
      if (qr) {
        const png = await QRCode.toBuffer(qr, { width: 320, margin: 2 });
        mail.html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1b2233">`
          + `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`
          + `<p style="text-align:center"><img src="cid:qr" width="260" height="260" alt="QR"><br>`
          + `<strong>${escapeHtml(qrCaption || '')}</strong></p>`
          + `<p style="color:#667085;font-size:13px">${escapeHtml(footer).replace(/\n/g, '<br>')}</p></div>`;
        mail.attachments = [{ filename: 'qr.png', content: png, cid: 'qr' }];
        // Imagen servida por la web (solo existe para tokens de pedidos reales): la usa Brevo.
        mail.qrImageUrl = qr.replace('/admin/qr/', '/qr-img/') + '.png';
      }
      await transport.sendMail(mail);
      log.run(to, fullSubject, logged, configured ? 'enviado' : 'simulado', null);
    } catch (err) {
      console.error('[mail] error enviando a', to, err.message);
      log.run(to, fullSubject, logged, 'error', err.message);
    }
  }

  function itemsText(lang, items) {
    const t = (k, p) => translate(lang, k, p);
    return items.map((it) => {
      const name = localized(lang, it, 'product_name');
      if (it.kind === 'pack') return `  · ${t('Descuento {name}', { name })}${it.quantity > 1 ? ` (x${it.quantity})` : ''} — ${formatMoney(it.unit_price_cents * it.quantity)}`;
      if (it.kind === 'gift') return `  · ${it.quantity} x ${name} (${t('de regalo')}) — ${formatMoney(0)}`;
      const extras = [
        it.color,
        it.option_value,
        it.size && t('talla {size}', { size: it.size }),
        it.custom_name && t('nombre jugador «{name}»', { name: it.custom_name }),
        it.custom_number && t('dorsal {number}', { number: it.custom_number }),
        it.no_custom && t('sin personalizar'),
      ].filter(Boolean).join(', ');
      return `  · ${it.quantity} x ${name}${extras ? ` (${extras})` : ''} — ${formatMoney(it.unit_price_cents * it.quantity)}`;
    }).join('\n');
  }

  const langOf = (user) => user.lang || DEFAULT_LANG;
  const who = (user) => user.player_name || user.email || user.dni || user.username;
  const qrUrl = (appUrl, token) => `${appUrl}/admin/qr/${token}`;

  return {
    send,
    /** true si los correos salen de verdad (Brevo o SMTP); false si solo se registran. */
    enabled: configured,

    accountActivated(user, password, appUrl) {
      const lang = langOf(user);
      const t = (k, p) => translate(lang, k, p);
      return send(user.email, t('Tu acceso a la tienda del club'),
        `${t('Hola,')}\n\n${t('Se ha creado tu cuenta en la tienda del club.')}\n\n`
        + `${t('Usuario')}: ${user.email}\n${t('Contraseña')}: ${password}\n\n`
        + `${t('Entra en {url}', { url: `${appUrl}/login` })}\n${t('Guarda este correo: necesitarás la contraseña para volver a entrar.')}`,
        { lang });
    },

    resetLink(user, link) {
      const lang = langOf(user);
      const t = (k, p) => translate(lang, k, p);
      return send(user.email, t('Recuperar acceso'),
        `${t('Hola,')}\n\n${t('Hemos recibido una solicitud para recuperar el acceso de {name}.', { name: who(user) })}\n\n`
        + `${t('Usuario')}: ${user.email || user.username}\n\n${t('Para generar una contraseña nueva abre este enlace (válido 1 hora):')}\n${link}\n\n`
        + t('Si no lo has pedido tú, ignora este correo: tu contraseña actual sigue funcionando.'), { lang });
    },

    newPassword(user, password) {
      const lang = langOf(user);
      const t = (k, p) => translate(lang, k, p);
      return send(user.email, t('Tu nueva contraseña'),
        `${t('Hola,')}\n\n${t('Contraseña')}: ${password}\n${t('Usuario')}: ${user.email || user.username}`, { lang });
    },

    emailChanged(user, email) {
      const lang = langOf(user);
      const t = (k, p) => translate(lang, k, p);
      return send(email, t('Correo de contacto actualizado'), t('Este es ahora el correo de contacto de tu cuenta de la tienda del club.'), { lang });
    },

    /** Pedido realizado: incluye el QR de PAGO. */
    orderPlaced(user, order, items, appUrl) {
      const lang = langOf(user);
      const t = (k, p) => translate(lang, k, p);
      const code = orderCode(order.id);
      send(user.email, t('Pedido {code} recibido', { code }),
        `${t('Hola,')}\n\n${t('Hemos recibido el pedido {code} de {name}.', { code, name: who(user) })}\n\n`
        + `${itemsText(lang, items)}\n\n${t('Total a pagar')}: ${formatMoney(order.total_cents)}\n\n`
        + `${t('Estado: PENDIENTE DE PAGO. El pago se realiza en efectivo a la comisión.')}\n`
        + `${t('Enseña este QR cuando pagues y también cuando vayas a recoger el material: es lo único que necesitas.')}\n`
        + `${t('Mientras no esté pagado puedes cancelarlo desde la web.')}\n\n`
        + t('Consulta tus pedidos en {url}', { url: `${appUrl}/pedidos` }),
        { lang, qr: qrUrl(appUrl, order.pay_token), qrCaption: t('QR del pedido {code}', { code }) });
      if (adminEmail) {
        send(adminEmail, translate(adminLang, 'Nuevo pedido {code} · {name}', { code, name: who(user) }),
          `${itemsText(adminLang, items)}\n\n${translate(adminLang, 'Total')}: ${formatMoney(order.total_cents)}\n${appUrl}/admin/pedidos/${order.id}`,
          { lang: adminLang });
      }
    },

    /** Cambio de estado. Al cobrar se envía el comprobante con el mismo QR del pedido (sirve para recoger). */
    statusChanged(user, order, appUrl, collector) {
      const lang = langOf(user);
      const t = (k, p) => translate(lang, k, p);
      const code = orderCode(order.id);
      const subject = t('Pedido {code}: {status}', { code, status: t(STATUS[order.status].label) });
      const intro = `${t('Hola,')}\n\n`;
      const tail = `\n\n${t('Pedido {code} · {name}', { code, name: who(user) })}`;
      if (order.status === 'pendiente_entrega') {
        send(user.email, subject,
          `${intro}${t('COMPROBANTE DE PAGO')}\n${t('Hemos recibido {amount} en efectivo', { amount: formatMoney(order.total_cents) })}`
          + `${collector ? ` (${t('registrado por {who}', { who: collector })})` : ''} · ${new Date(order.paid_at).toLocaleString(lang === 'ca' ? 'ca-ES' : 'es-ES', { timeZone: 'Europe/Madrid' })}.\n\n`
          + `${t('El pedido está PENDIENTE DE ENTREGA. Te avisaremos cuando esté listo para recoger.')}\n`
          + `${t('Para recogerlo, enseña este QR a la comisión.')}${tail}`,
          { lang, qr: qrUrl(appUrl, order.pay_token), qrCaption: t('QR del pedido {code}', { code }) });
        return;
      }
      const messages = {
        entregado: t('El pedido se ha marcado como ENTREGADO. ¡Que lo disfrutéis! Si hay algún problema, habla con la comisión.'),
        cancelado: t('El pedido se ha CANCELADO.'),
        pendiente_pago: t('El pedido vuelve a estar PENDIENTE DE PAGO ({amount}).', { amount: formatMoney(order.total_cents) }),
      };
      send(user.email, subject, `${intro}${messages[order.status]}${tail}`, { lang });
      if (adminEmail && order.status === 'cancelado') {
        send(adminEmail, translate(adminLang, 'Pedido {code} cancelado · {name}', { code, name: who(user) }),
          `${appUrl}/admin/pedidos/${order.id}`, { lang: adminLang });
      }
    },

    /** Aviso de que el material ha llegado y se puede recoger. */
    readyForPickup(user, order, appUrl, message) {
      const lang = langOf(user);
      const t = (k, p) => translate(lang, k, p);
      const code = orderCode(order.id);
      return send(user.email, t('¡Tu pedido {code} ya se puede recoger!', { code }),
        `${t('Hola,')}\n\n${t('El material del pedido {code} ({name}) ya ha llegado.', { code, name: who(user) })}\n\n`
        + `${message ? `${message}\n\n` : ''}`
        + t('Para recogerlo, enseña este QR a la comisión.'),
        { lang, qr: qrUrl(appUrl, order.pay_token), qrCaption: t('QR del pedido {code}', { code }) });
    },
  };
}

module.exports = { createMailer, parseAddress };
