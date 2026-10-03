function node(config, publicURL) {
  const url = new URL(publicURL);
  const protocol = config.协议类型;
  if (!['vless', 'trojan', 'ss'].includes(protocol)) throw new Error('Choose VLESS, Trojan, or Shadowsocks');
  if (config.传输协议 !== 'ws') throw new Error('Self-hosted deployment currently supports WebSocket transport; choose ws');
  return {
    protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), authority: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), tls: url.protocol === 'https:',
    uuid: config.UUID, path: config.完整节点路径 || '/',
    name: config.优选订阅生成.SUBNAME || 'Home server',
    method: config.SS?.加密方式 || 'aes-128-gcm'
  };
}

export function makeNodeLink(config, publicURL) {
  const n = node(config, publicURL);
  if (n.protocol === 'ss') {
    const path = new URL(n.path, 'http://local.invalid');
    path.searchParams.set('enc', n.method);
    const plugin = `v2ray-plugin;mode=websocket;host=${n.hostname};path=${path.pathname + path.search}${n.tls ? ';tls' : ''};mux=0`;
    return `ss://${Buffer.from(n.method + ':' + n.uuid).toString('base64')}@${n.authority}:${n.port}?plugin=${encodeURIComponent(plugin)}#${encodeURIComponent(n.name)}`;
  }
  const query = new URLSearchParams({ security: n.tls ? 'tls' : 'none', type: 'ws', host: n.hostname, path: n.path, encryption: 'none' });
  if (n.tls) { query.set('sni', n.hostname); query.set('fp', 'chrome'); }
  return `${n.protocol}://${n.uuid}@${n.authority}:${n.port}?${query}#${encodeURIComponent(n.name)}`;
}

export function makeSubscription(config, request, publicURL) {
  try {
    const n = node(config, publicURL);
    const url = new URL(request.url);
    const ua = (request.headers.get('user-agent') || '').toLowerCase();
    const target = url.searchParams.get('target') || (url.searchParams.has('clash') || /clash|mihomo/.test(ua) ? 'clash'
      : url.searchParams.has('singbox') || /sing-box|singbox/.test(ua) ? 'singbox' : 'mixed');
    const headers = { 'Cache-Control': 'no-store', 'Profile-Update-Interval': '3', 'Profile-web-page-url': publicURL + '/admin' };
    let body;
    if (target === 'clash') {
      const proxy = { name: n.name, type: n.protocol === 'ss' ? 'ss' : n.protocol, server: n.hostname, port: n.port, udp: false };
      if (n.protocol === 'ss') {
        const path = new URL(n.path, 'http://local.invalid');
        path.searchParams.set('enc', n.method);
        Object.assign(proxy, { cipher: n.method, password: n.uuid, plugin: 'v2ray-plugin',
          'plugin-opts': { mode: 'websocket', host: n.hostname, path: path.pathname + path.search, tls: n.tls, mux: false } });
      } else {
        Object.assign(proxy, { [n.protocol === 'vless' ? 'uuid' : 'password']: n.uuid, tls: n.tls,
          network: 'ws', 'ws-opts': { path: n.path, headers: { Host: n.hostname } } });
        if (n.tls) Object.assign(proxy, { servername: n.hostname, sni: n.hostname, 'client-fingerprint': 'chrome' });
      }
      // JSON is valid YAML and avoids a second serialization dependency.
      body = JSON.stringify({ 'mixed-port': 7890, 'allow-lan': false, mode: 'rule', proxies: [proxy],
        'proxy-groups': [{ name: 'Proxy', type: 'select', proxies: [n.name, 'DIRECT'] }], rules: ['MATCH,Proxy'] }, null, 2);
      headers['Content-Type'] = 'application/yaml; charset=utf-8';
    } else if (target === 'singbox') {
      if (n.protocol === 'ss') throw new Error('Shadowsocks with v2ray-plugin: use the mixed link or Clash subscription');
      const outbound = { type: n.protocol, tag: 'proxy', server: n.hostname, server_port: n.port,
        [n.protocol === 'vless' ? 'uuid' : 'password']: n.uuid, network: 'tcp',
        transport: { type: 'ws', path: n.path, headers: { Host: n.hostname } } };
      if (n.tls) outbound.tls = { enabled: true, server_name: n.hostname, utls: { enabled: true, fingerprint: 'chrome' } };
      body = JSON.stringify({ inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 }],
        outbounds: [outbound, { type: 'direct', tag: 'direct' }], route: { final: 'proxy' } }, null, 2);
      headers['Content-Type'] = 'application/json; charset=utf-8';
    } else if (target === 'mixed' || target === 'v2ray') {
      body = makeNodeLink(config, publicURL);
      if (!ua.includes('mozilla') || url.searchParams.has('b64') || url.searchParams.has('base64')) body = Buffer.from(body).toString('base64');
      headers['Content-Type'] = 'text/plain; charset=utf-8';
    } else return new Response('Supported targets: mixed, clash, singbox', { status: 400 });
    return new Response(body, { headers });
  } catch (error) {
    return new Response(error.message, { status: 400 });
  }
}
