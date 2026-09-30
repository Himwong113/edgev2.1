# Deploy edgetunnel on a Linux home server or NAS

This deployment runs the existing VLESS, Trojan, and Shadowsocks proxy engine in Node.js, with Docker Compose as the main installation method. It serves an English admin page and stores settings in a local Docker volume. You do not need a Cloudflare account, Workers subscription, or KV namespace.

Traffic exits through your home server's Internet connection. This is a client proxy, not a WireGuard/OpenVPN server or a routed connection to your entire home network. Use a compatible proxy client; its system proxy or TUN mode determines which applications use the tunnel.

## Quick start: home network

Install Docker Engine and Docker Compose on the server. Run the following commands inside this repository. Replace `192.168.1.10` with your server's LAN address; reserve that address in your router's DHCP settings.

```bash
docker build -t edgetunnel-self-hosted:local .
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD,target=/setup" \
  edgetunnel-self-hosted:local node self-host/setup.js \
  --url http://192.168.1.10:8080 --bind 192.168.1.10 --output /setup/.env
docker compose up -d
```

The setup command creates `.env` with a random admin password, UUID, and subscription key. It refuses to overwrite an existing file. Open `.env` locally to read `ADMIN`; keep that file private.

Open `http://192.168.1.10:8080/admin`, sign in with `ADMIN`, and copy the node link or subscription URL into your client. VLESS is the default protocol. The server must allow inbound TCP port 8080 from your LAN. The server address in `PUBLIC_URL` must be reachable from your client.

Plain HTTP/WebSocket is intended for trusted LAN testing. For remote access or encrypted transport, use HTTPS below. VLESS itself does not encrypt a plain WebSocket connection.

For use only on the server computer, omit `--url` and `--bind` from the setup command: the defaults are `http://localhost:8080` and `127.0.0.1`.

If you prefer manual configuration, copy `.env.example` to `.env`, replace `ADMIN` with a long random password, and set `PUBLIC_URL` and `BIND_ADDRESS`. For example, `openssl rand -hex 24` generates a suitable password. A blank UUID is generated once and persisted in the data volume. Startup requires an admin password of at least 16 characters.

## Remote access with HTTPS

Use a domain pointing to your home's public IP, and forward TCP ports 80 and 443 from the router to this server. Configure dynamic DNS if your public IP changes. If your ISP uses carrier-grade NAT, ordinary router port forwarding cannot make the server publicly reachable; you need a reachable public address or a separately configured relay.

Edit `.env`:

```dotenv
PUBLIC_URL=https://vpn.example.com
VPN_DOMAIN=vpn.example.com
BIND_ADDRESS=127.0.0.1
HTTP_PORT=8080
```

Start the tunnel and Caddy:

```bash
docker compose -f compose.yaml -f compose.https.yaml up -d --build
```

Open `https://vpn.example.com/admin` and re-import the newly generated client link. Caddy provisions and renews the TLS certificate and forwards WebSocket connections to the tunnel. See [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https) and [WebSocket reverse proxy support](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Keep ports 80 and 443 available for Caddy. On a NAS already using those ports, configure its existing HTTPS reverse proxy to forward to `http://127.0.0.1:8080` with WebSocket upgrades enabled, and run only `compose.yaml`. Set `PUBLIC_URL` to the actual HTTPS address used by clients. No administrator privileges, host networking, TUN device, or privileged container mode are required by this server.

## Clients and supported features

| Feature | Self-hosted deployment |
| --- | --- |
| VLESS, Trojan | TCP over WebSocket; optional TLS through Caddy |
| Shadowsocks | AEAD over WebSocket with v2ray-plugin; AES-128-GCM tested |
| Mixed subscription | Base64 node links; import into clients supporting the selected protocol |
| Clash/Mihomo subscription | Generated locally; JSON is valid YAML |
| Sing-box subscription | Complete local SOCKS/HTTP proxy configuration for VLESS or Trojan |
| General UDP traffic | Unsupported; VLESS/Trojan retain upstream DNS-only handling |
| gRPC/XHTTP | Not enabled in the self-hosted HTTP server; select `ws` |
| Cloudflare optimized IPs, ECH, CF usage statistics | Not part of the local deployment workflow |

The admin page's subscription format selector creates the appropriate URL. Sing-box output listens on `127.0.0.1:2080` on the client; Clash output uses port 7890. These are client configuration ports, not server ports. Generated schemas follow the [Sing-box VLESS](https://sing-box.sagernet.org/configuration/outbound/vless/), [WebSocket transport](https://sing-box.sagernet.org/configuration/shared/v2ray-transport/), and [Mihomo VLESS](https://wiki.metacubex.one/en/config/proxies/vless/) documentation.

The mixed link and Clash subscription support Shadowsocks with v2ray-plugin. The Sing-box subscription rejects that combination with an English explanation. Subscription URLs contain credentials; treat them like passwords.

The normal settings controls are in English. Advanced JSON preserves the upstream configuration field names for compatibility. The server's address, TLS, and port are derived from `PUBLIC_URL`; the upstream Cloudflare IP pool and third-party subscription conversion service are bypassed. Explicit chained-proxy paths remain available for advanced use, but this deployment's default is direct TCP egress.

## Configuration

| Setting | Purpose |
| --- | --- |
| `ADMIN` | Admin password, at least 16 characters |
| `UUID` | Fixed UUIDv4 for proxy authentication; blank generates a persisted identity |
| `KEY` | Subscription shortcut key; generated by the setup command |
| `PUBLIC_URL` | Client-facing HTTP/HTTPS origin, including a nonstandard port if needed |
| `BIND_ADDRESS` | Docker host address to expose; defaults to `127.0.0.1` |
| `HTTP_PORT` | Docker host HTTP port; defaults to 8080 |
| `VPN_DOMAIN` | Domain for the optional Caddy HTTPS service |
| `TUNNEL_PATH` | WebSocket path; defaults to `/` |
| `OFF_LOG` | Disable stored request logs; defaults to `true` in Compose |
| `DEBUG` | Print detailed connection diagnostics; defaults to `false` |
| `PROXYIP` | Optional explicit fallback proxy; blank uses direct egress only |

Changing the UUID changes proxy credentials. Changing the public hostname changes subscription tokens; refresh the client's subscription URL afterward. Changing only `ADMIN` does not change an explicitly configured or persisted UUID. After editing `.env`, run the relevant Compose `up -d` command again to recreate the container.

## Operation and backups

For the basic LAN deployment:

```bash
docker compose ps
docker compose logs --tail=100 tunnel
curl http://127.0.0.1:8080/healthz
docker compose down
```

Use the configured LAN address for the health check if `BIND_ADDRESS` is a LAN IP. For HTTPS deployment, include `-f compose.yaml -f compose.https.yaml` in each Compose command. `down` preserves configuration volumes; do not add `-v` unless you intend to erase saved settings and generated identities.

Back up `.env` and the `tunnel_data` volume. Caddy's certificate state lives in `caddy_data`. Volumes are prefixed with your Compose project name; find the exact names with `docker volume ls`. If restoring a bind-mounted data directory instead, ensure it is writable by container UID 1000.

The container runs as the unprivileged `node` user, drops Linux capabilities, and uses a persistent data volume. Configuration files are replaced atomically. The `/healthz` endpoint checks the running application; it does not verify router forwarding, public DNS, certificates, or the availability of every outbound destination.

## Run without Docker

With Node.js 22.9 or later:

```bash
npm ci
npm run setup -- --url http://192.168.1.10:8080
LISTEN_HOST=0.0.0.0 npm start
```

The native server defaults to binding `127.0.0.1`; `LISTEN_HOST` changes that binding. Native settings are saved in `./data`, or the directory set by `DATA_DIR`. `BIND_ADDRESS` applies only to Docker's published port. Use your service manager to restart the process after a reboot, or use Compose's restart policy.

## Validation

```bash
npm ci
npm test
```

The 11 integration tests exercise local login, secure-cookie handling, authenticated settings, native subscription formats, invalid credentials, file persistence, VLESS early data, IPv6 addresses, a 256 KiB transfer, and real TCP echo traffic through VLESS, Trojan, and Shadowsocks AEAD. The Docker image was also verified for startup, login, configuration persistence after restart, and VLESS WebSocket traffic through a running Caddy reverse proxy. Public router access and certificate issuance depend on your server/domain and must be checked there.
