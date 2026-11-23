(async () => {
  const $ = (s) => document.querySelector(s);

  // ждём, пока скрипт поднимется
  const started = Date.now();
  while (!window.__volna && Date.now() - started < 8000) await new Promise((r) => setTimeout(r, 200));

  if ($('#auth-name').offsetParent === null) {
    return JSON.stringify({ step: 'setup-panel', visible: !$('#api-setup').hidden });
  }

  $('#auth-name').value = 'anya';
  $('#auth-pass').value = '1234';
  $('#auth-submit').click();

  await new Promise((r) => setTimeout(r, 5000));

  const photos = [...document.querySelectorAll('.photo')];
  return JSON.stringify({
    step: 'chat',
    conversation: !$('#conversation').hidden,
    me: $('#me-name').textContent,
    chats: document.querySelectorAll('.chat-item').length,
    photos: photos.length,
    photosLoaded: photos.filter((img) => img.complete && img.naturalWidth > 0).length,
    polling: window.__volna.polling,
    server: window.__volna ? location.hash.slice(0, 60) : '',
  });
})();
