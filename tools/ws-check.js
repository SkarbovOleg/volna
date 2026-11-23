(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const started = Date.now();
  while ((!window.__volna || !window.__volna.me) && Date.now() - started < 10000) await sleep(200);

  const api = (window.__volnaApi || '') + '/api';
  const text = 'проверка живой доставки ' + Date.now();

  const login = await fetch(api + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'mark', password: '1234' }),
  }).then((r) => r.json());
  const list = await fetch(api + '/users', { headers: { authorization: 'Bearer ' + login.token } }).then((r) => r.json());
  const anya = list.users.find((u) => u.name === 'anya');

  const sent = Date.now();
  await fetch(api + '/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + login.token },
    body: JSON.stringify({ to: anya.id, body: text }),
  });

  let delivered = null;
  while (Date.now() - sent < 5000) {
    if (document.body.innerText.includes(text)) {
      delivered = Date.now() - sent;
      break;
    }
    await sleep(60);
  }

  return JSON.stringify({
    ws: window.__volna.ws ? window.__volna.ws.readyState : -1,
    es: window.__volna.es ? window.__volna.es.readyState : -1,
    polling: window.__volna.polling,
    banner: !document.querySelector('#conn-banner').hidden,
    deliveredMs: delivered,
  });
})();
