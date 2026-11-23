(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const started = Date.now();
  while ((!window.__volna || !window.__volna.me) && Date.now() - started < 8000) await sleep(150);

  document.querySelector('#stickers').click();
  await sleep(700);

  return JSON.stringify({
    panel: !document.querySelector('#sticker-panel').hidden,
    items: document.querySelectorAll('.sticker-item').length,
    loaded: [...document.querySelectorAll('.sticker-item img')].filter((i) => i.complete && i.naturalWidth > 0).length,
  });
})();
