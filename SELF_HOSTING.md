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

## Small VM: 1 vCPU and 512 MiB RAM

For 1–5 personal devices, enable the optional resource profile after setting
up `.env` as above. It preserves your credentials and existing data volume:

```bash
docker compose -f compose.yaml -f compose.small-vm.yaml up -d --build
```

For public HTTPS, use all four files:

```bash
docker compose -f compose.yaml -f compose.https.yaml \
  -f compose.small-vm.yaml -f compose.small-vm.https.yaml up -d --build
```

The separate HTTPS resource override avoids starting Caddy in a LAN-only
deployment. Include the same files when running `ps`, `logs`, or subsequent
`up` commands. A plain `docker compose up` removes the opt-in resource
settings when it recreates the service.

Building an image can require more memory than running it. If the 512 MiB
VM cannot build comfortably, build on another machine with the same CPU
architecture, transfer the image using `docker save`/`docker load`, then
run the profile command with `--no-build` instead of `--build`.

| Resource | Tunnel | Optional Caddy |
| --- | --- | --- |
| Container memory cap | 192 MiB | 96 MiB |
| Swap allowance beyond memory cap | None | None |
| Runtime memory tuning | 96 MiB JavaScript heap | 64 MiB Go soft limit |
| Process/thread cap | 64 | 64 |
| CPU tuning | At most 1 CPU | Go scheduler parallelism of 1 |

Heap/Go limits are not total memory limits; buffers, native allocations, and
other overhead also count against the container cap. Caddy's Go limit is
soft; see [Go's memory-limit guidance](https://go.dev/doc/gc-guide#Memory_limit).
Limits are not reservations: Linux and Docker use the remaining VM
memory, and containers normally use less than their caps. The profile also
rotates container logs, disables stored request logs/debug output, and
keeps direct and proxy dialing at one attempt. The image uses Node.js 22
Alpine and a lightweight local HTTP health check. See the
[official Node image variants](https://github.com/nodejs/docker-node/blob/main/README.md)
and [Docker resource limits](https://docs.docker.com/engine/containers/resource_constraints/).

All self-hosted profiles now have these tunnel safeguards:

- At most 128 concurrent connections, including pending upgrades;
  excess upgrades receive HTTP 503 with an English explanation.
- Authentication must finish within 10 seconds, including Shadowsocks
  handshakes. Idle unauthenticated connections are closed.
- Each WebSocket message is limited to 512 KiB. Clients must split larger
  transfers into messages; the total transfer size is not restricted.
- Input pauses at 256 KiB of queued/processing data and resumes below
  64 KiB, with a hard 1 MiB limit per tunnel and a shared 32 MiB budget.
- Local TCP response chunks are sent immediately, with send completion
  awaited before reading the next chunk. WebSocket compression stays off.

These limits protect the tunnel queues; they are not a comprehensive
Internet-facing abuse/rate-limiting policy. Use HTTPS for remote access,
keep the admin password private, and monitor container health and memory.
Authentication or queue-limit failures close the affected connection,
not the entire application.

For native Node.js, use `RUNTIME_PROFILE=small-vm` and
`NODE_OPTIONS=--max-old-space-size=96` with your service manager. Native
execution still needs OS/service-manager limits if you want the same
total-memory or CPU caps as Docker.

The target is at least 100 Mbps on suitable hardware, not a speed guarantee.
Container-limited measurements and remaining limitations are recorded in
[SMALL_VM_RESULTS.md](./SMALL_VM_RESULTS.md). A real 512 MiB VM, its Internet
uplink, router forwarding, and your actual clients still need validation.

### Rollback

Before an upgrade, retain the currently running image under a separate tag
and back up `.env` and `tunnel_data`. If the `local` image tag refers to your
running deployment, you can save it with:

```bash
docker image tag edgetunnel-self-hosted:local edgetunnel-self-hosted:before-small-vm
```

To remove only the resource profile, run the original Compose command,
omitting the two small-VM files. This keeps the new runtime safety and
forwarding changes. To restore the old runtime too, restore the saved tag:

```bash
docker image tag edgetunnel-self-hosted:before-small-vm edgetunnel-self-hosted:local
docker compose up -d --no-build
```

For HTTPS rollback, include `-f compose.yaml -f compose.https.yaml` in that
last command. Do not use `down -v` or change the Compose project name:
either would remove or bypass your existing saved settings. Client links
do not need changing just to enable or remove the resource profile.

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
| `RUNTIME_PROFILE` | `standard` or `small-vm`; the latter forces quiet logging and single dialing; Docker limits require the Compose overrides |

Changing the UUID changes proxy credentials. Changing the public hostname changes subscription tokens; refresh the client's subscription URL afterward. Changing only `ADMIN` does not change an explicitly configured or persisted UUID. After editing `.env`, run the relevant Compose `up -d` command again to recreate the container.

## Operation and backups

For the basic LAN deployment:

```bash
docker compose ps
docker compose logs --tail=100 tunnel
curl --noproxy '*' http://127.0.0.1:8080/healthz
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

The tests cover login, cookies, subscriptions, persistence, early data,
IPv6, and real VLESS/Trojan/Shadowsocks traffic. Additional tests exercise
queue budgets and cleanup, pause/resume, capacity rejection, authentication
timeouts, blocked/slow peers, many-record Shadowsocks streams, and failed
outbound connections.

To check Docker and Caddy without changing a running deployment:

```bash
docker build -t edgetunnel-self-hosted:small-vm-test .
npm run test:docker
```

The check creates a separate `edgetunnel-smallvm-verify` Compose project
with random test credentials and ephemeral loopback ports, verifies login,
settings persistence, TLS forwarding and effective resource limits, then
removes only that test project's containers and temporary volumes. It
refuses to reuse an existing verification project. Docker Compose 2.24.4
or later is required for this test's [`!override` port mappings](https://docs.docker.com/reference/compose-file/merge/#replace-value). Its
localhost/internal-CA TLS exception is test-only; normal clients must
validate their server's certificate.

The repeatable throughput/load harness is `npm run benchmark -- ...`.
See [SMALL_VM_RESULTS.md](./SMALL_VM_RESULTS.md) for its isolated test setup,
commands and recorded results. It must not be pointed at a production
service. Public access and public certificate issuance depend on your
server/domain and must be checked there.
