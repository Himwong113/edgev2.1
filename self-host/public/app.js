const byId = id => document.getElementById(id);
const status = message => { byId('status').textContent = message; };
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, redirect: 'manual' });
  if (response.type === 'opaqueredirect' || response.status === 302) { location.href = '/login'; throw new Error('Please sign in'); }
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
if (byId('login')) {
  byId('login').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const response = await fetch('/login', { method: 'POST', body: new URLSearchParams(new FormData(event.target)), redirect: 'manual' });
      if (response.ok && response.headers.get('content-type')?.includes('application/json') && (await response.json()).success) location.href = '/admin';
      else status('Incorrect password');
    } catch (error) { status(error.message); }
  });
} else {
  let config;
  function updateSubscription() {
    const url = new URL('/sub', location.origin);
    url.searchParams.set('token', config.优选订阅生成.TOKEN);
    url.searchParams.set('target', byId('format').value);
    url.searchParams.set('b64', '1');
    byId('subscription').value = url.href;
  }
  async function load() {
    config = await api('/admin/config.json');
    byId('node').value = config.LINK;
    byId('protocol').value = config.协议类型;
    byId('name').value = config.优选订阅生成.SUBNAME;
    byId('config').value = JSON.stringify(config, null, 2);
    updateSubscription();
    status('Ready');
  }
  async function save(next) {
    if (next.传输协议 !== 'ws') throw new Error('Use ws transport for this deployment');
    await api('/admin/config.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
    await load();
    status('Settings saved');
  }
  byId('format').addEventListener('change', updateSubscription);
  byId('settings').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const next = structuredClone(config);
      next.协议类型 = byId('protocol').value;
      next.优选订阅生成.SUBNAME = byId('name').value;
      await save(next);
    } catch (error) { status(error.message); }
  });
  byId('save-json').addEventListener('click', async () => {
    try { await save(JSON.parse(byId('config').value)); } catch (error) { status(error.message); }
  });
  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const input = byId(button.dataset.copy);
    try { await navigator.clipboard.writeText(input.value); status('Copied'); }
    catch { input.focus(); input.select(); status('Text selected; use your device’s Copy command'); }
  }));
  load().catch(error => status(error.message));
}
