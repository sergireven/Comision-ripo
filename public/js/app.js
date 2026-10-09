// Cuenta atrás hasta el cierre/apertura del periodo de pedidos.
(function () {
  var WORDS = {
    es: { secs: 'unos segundos', day: ' día ', days: ' días ' },
    ca: { secs: 'uns segons', day: ' dia ', days: ' dies ' },
  };
  function fmt(ms, lang) {
    var w = WORDS[lang] || WORDS.es;
    if (ms <= 0) return w.secs;
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    if (d > 0) return d + (d === 1 ? w.day : w.days) + h + ' h ' + m + ' min';
    if (h > 0) return h + ' h ' + m + ' min ' + s + ' s';
    return m + ' min ' + s + ' s';
  }
  var els = document.querySelectorAll('[data-countdown]');
  function tick() {
    els.forEach(function (el) {
      var left = new Date(el.getAttribute('data-countdown')).getTime() - Date.now();
      el.textContent = fmt(left, el.getAttribute('data-lang'));
      if (left <= 0 && !el.dataset.reloaded) { el.dataset.reloaded = '1'; setTimeout(function () { location.reload(); }, 1500); }
    });
  }
  if (els.length) { tick(); setInterval(tick, 1000); }

  // Confirmaciones antes de acciones importantes.
  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) { if (!confirm(f.getAttribute('data-confirm'))) e.preventDefault(); });
  });

  // Selects que filtran al cambiar.
  document.querySelectorAll('select[data-autosubmit]').forEach(function (s) {
    s.addEventListener('change', function () { s.form.submit(); });
  });

  document.querySelectorAll('[data-print]').forEach(function (b) {
    b.addEventListener('click', function () { window.print(); });
  });

  // Vista previa de la foto del producto.
  document.querySelectorAll('input[type=file][data-preview]').forEach(function (input) {
    input.addEventListener('change', function () {
      var img = document.querySelector(input.getAttribute('data-preview'));
      if (img && input.files[0]) { img.src = URL.createObjectURL(input.files[0]); img.hidden = false; }
    });
  });

  // Personalización opcional: los campos de nombre y dorsal solo aparecen (y son obligatorios) al elegir «Personalizar».
  document.querySelectorAll('[data-custom-choice]').forEach(function (box) {
    var fields = box.nextElementSibling;
    if (!fields || !fields.hasAttribute('data-custom-fields')) return;
    function sync() {
      var checked = box.querySelector('input:checked');
      var on = !!checked && checked.value === '0';
      fields.hidden = !on;
      fields.querySelectorAll('input').forEach(function (i) { i.disabled = !on; });
    }
    box.addEventListener('change', sync);
    sync();
  });

  // Evita dobles envíos.
  document.querySelectorAll('form').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (e.defaultPrevented) return;
      setTimeout(function () { f.querySelectorAll('button').forEach(function (b) { b.disabled = true; }); }, 0);
    });
  });
})();
