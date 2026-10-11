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
  var sendBtn = form.querySelector('[data-pollet-send]');
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
    stopSpeaking();
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
      if (reply) { history.push({ role: 'assistant', content: reply }); save(); speak(reply); }
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
  root.querySelector('[data-pollet-close]').addEventListener('click', function () { stopSpeaking(); open(false); });
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

  // --- Voz (gratis: la ponen los navegadores) ---
  var lang = root.getAttribute('data-lang') === 'es' ? 'es-ES' : 'ca-ES';

  // Escuchar: lee las respuestas en voz alta si está activado (se recuerda en este navegador).
  var voiceBtn = root.querySelector('[data-pollet-voice]');
  var voiceOn = false;
  function pickVoice() {
    var voices = window.speechSynthesis.getVoices();
    var base = lang.slice(0, 2);
    return voices.find(function (v) { return v.lang && v.lang.toLowerCase().indexOf(base) === 0; })
      || voices.find(function (v) { return v.lang && v.lang.toLowerCase().indexOf('es') === 0; }) || null;
  }
  function stopSpeaking() { if (window.speechSynthesis) window.speechSynthesis.cancel(); }
  function speak(text) {
    if (!voiceOn || !window.speechSynthesis) return;
    stopSpeaking();
    var u = new SpeechSynthesisUtterance(text.replace(/https?:\/\/\S+/g, root.getAttribute('data-link')).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ''));
    var v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = lang; }
    window.speechSynthesis.speak(u);
  }
  function setVoice(on) {
    voiceOn = on;
    voiceBtn.textContent = on ? '🔊' : '🔇';
    voiceBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    try { localStorage.setItem(KEY + '-voice', on ? '1' : ''); } catch (e) { /* nada */ }
    if (!on) stopSpeaking();
  }
  if ('speechSynthesis' in window && window.SpeechSynthesisUtterance) {
    voiceBtn.hidden = false;
    window.speechSynthesis.getVoices();
    try { setVoice(localStorage.getItem(KEY + '-voice') === '1'); } catch (e) { setVoice(false); }
    voiceBtn.addEventListener('click', function () { setVoice(!voiceOn); });
  }

  // Hablar: el navegador pasa la voz a texto y se envía la pregunta.
  var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var micBtn = root.querySelector('[data-pollet-mic]');
  if (Recognition) {
    var rec = null;
    var listening = false;
    micBtn.hidden = false;
    micBtn.addEventListener('click', function () {
      if (listening) { rec.stop(); return; }
      if (busy) return;
      stopSpeaking();
      rec = new Recognition();
      rec.lang = lang;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      var finalText = '';
      var placeholder = input.placeholder;
      rec.onstart = function () { listening = true; micBtn.classList.add('listening'); input.value = ''; input.placeholder = root.getAttribute('data-listening'); };
      rec.onresult = function (e) {
        var text = '';
        for (var i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
        input.value = text;
        if (e.results[e.results.length - 1].isFinal) finalText = text;
      };
      rec.onerror = function () { /* sin permiso o sin voz: no se hace nada */ };
      rec.onend = function () {
        listening = false; micBtn.classList.remove('listening'); input.placeholder = placeholder;
        var text = (finalText || input.value).trim();
        if (text) { input.value = ''; ask(text); }
      };
      try { rec.start(); } catch (e) { listening = false; }
    });
  }

  load();
  try { if (sessionStorage.getItem(KEY + '-open')) open(true); } catch (e) { /* nada */ }
})();
