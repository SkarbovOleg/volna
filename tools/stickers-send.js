(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const started = Date.now();
  while ((!window.__volna || !window.__volna.me) && Date.now() - started < 8000) await sleep(150);

  document.querySelector('#stickers').click();
  await sleep(600);

  // отправляем стикер «любовь»
  const items = [...document.querySelectorAll('.sticker-item')];
  const target = items[2];
  target.click();
  await sleep(1500);

  document.querySelector('#stickers').click();
  await sleep(400);

  return JSON.stringify({
    panel: !document.querySelector('#sticker-panel').hidden,
    stickers: document.querySelectorAll('.bubble.is-sticker').length,
    lastIsSticker: (window.__volna.threads.get(window.__volna.activeId) || { messages: [] }).messages.at(-1)?.kind,
  });
})();
