// Pollet: chat con el asistente de la tienda. La conversación se guarda en la pestaña (sessionStorage).
(function () {
  var root = document.querySelector('[data-pollet]');
  if (!root) return;
  var panel = root.querySelector('[data-pollet-panel]');
  var fab = root.querySelector('[data-pollet-open]');
  var log = root.querySelector('[data-pollet-log]');
  var chips = root.querySelector('[data-pollet-chips]');
  var form = root.querySelector('[data-pollet-form]');
  var input = form.querySelector('textarea');
  var sendBtn = form.querySelector('button');
  var KEY = 'pollet-chat';
  var history = [];
  var busy = false;

  function load() {
    try { history = JSON.parse(sessionStorage.getItem(KEY) || '[]') || []; } catch (e) { history = []; }
    history.forEach(function (m) { add(m.role === 'user' ? 'user' : 'bot', m.content); });
    if (history.length && chips) chips.hidden = true;
  }
  function save() {
    try { sessionStorage.setItem(KEY, JSON.stringify(history.slice(-20))); } catch (e) { /* sin almacenamiento */ }
  }
  function add(kind, text) {
    var div = document.createElement('div');
    div.className = 'pollet-msg ' + kind;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }
  function open(show) {
    panel.hidden = !show;
    fab.setAttribute('aria-expanded', show ? 'true' : 'false');
    root.classList.toggle('is-open', show);
    try { sessionStorage.setItem(KEY + '-open', show ? '1' : ''); } catch (e) { /* nada */ }
    if (show) { log.scrollTop = log.scrollHeight; input.focus(); }
  }

  function ask(text) {
    text = text.trim();
    if (!text || busy) return;
    busy = true; sendBtn.disabled = true;
    if (chips) chips.hidden = true;
    add('user', text);
    history.push({ role: 'user', content: text });
    save();
    var wait = add('bot pending', root.getAttribute('data-thinking'));
    fetch('/asistente', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ _csrf: root.getAttribute('data-csrf'), messages: history.slice(-10) }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) { return { status: r.status, data: data }; });
    }).then(function (res) {
      var reply = res.data && res.data.reply;
      var msg = reply
        || (res.status === 429 ? root.getAttribute('data-limit')
          : res.data && res.data.error === 'refusal' ? root.getAttribute('data-refusal')
            : root.getAttribute('data-error'));
      wait.classList.remove('pending');
      wait.textContent = msg;
      if (reply) { history.push({ role: 'assistant', content: reply }); save(); }
      else { history.pop(); save(); }
    }).catch(function () {
      wait.classList.remove('pending');
      wait.textContent = root.getAttribute('data-error');
      history.pop(); save();
    }).then(function () {
      busy = false; sendBtn.disabled = false; input.focus();
      log.scrollTop = log.scrollHeight;
    });
  }

  fab.addEventListener('click', function () { open(panel.hidden); });
  root.querySelector('[data-pollet-close]').addEventListener('click', function () { open(false); });
  if (chips) chips.addEventListener('click', function (e) { if (e.target.tagName === 'BUTTON') ask(e.target.textContent); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value; input.value = ''; input.style.height = '';
    ask(text);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); }
  });
  input.addEventListener('input', function () {
    input.style.height = ''; input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) open(false); });

  load();
  try { if (sessionStorage.getItem(KEY + '-open')) open(true); } catch (e) { /* nada */ }
})();
