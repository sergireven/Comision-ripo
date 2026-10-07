// Escáner de QR dentro de la web de la comisión (usa la cámara trasera del móvil).
(function () {
  var btn = document.getElementById('scan-start');
  var box = document.getElementById('scanner');
  var video = document.getElementById('scan-video');
  var msg = document.getElementById('scan-msg');
  if (!btn) return;
  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var stream = null;

  function say(text) { msg.textContent = text; }

  function stop() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
  }

  function tick() {
    if (!stream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      var w = video.videoWidth;
      var h = video.videoHeight;
      var scale = Math.min(1, 640 / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        var m = /\/admin\/qr\/([0-9a-f]{64})/.exec(code.data);
        if (m) {
          stop();
          if (navigator.vibrate) navigator.vibrate(120);
          location.href = '/admin/qr/' + m[1];
          return;
        }
        say(btn.dataset.msgForeign);
      }
    }
    requestAnimationFrame(tick);
  }

  btn.addEventListener('click', function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
      say(btn.dataset.msgHttps);
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        box.hidden = false;
        btn.hidden = true;
        say(btn.dataset.msgScanning);
        return video.play();
      })
      .then(function () { requestAnimationFrame(tick); })
      .catch(function () { say(btn.dataset.msgDenied); });
  });

  window.addEventListener('pagehide', stop);
  // Si se llega desde «Escanear otro», se abre la cámara directamente.
  if (/[?&]auto=1/.test(location.search)) btn.click();
})();
