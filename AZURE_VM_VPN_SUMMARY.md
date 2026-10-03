# Azure VM VPN Setup Summary

This summary records a completed setup and the checks performed during
that session. It is not a fresh check of the live VM. Personal and
deployment-specific identifiers have been replaced with placeholders for
publication. Replace placeholders with your own values when using this guide.

## What we completed

- Connected to the Azure VM through the tmux VM session using SSH.
- Installed Docker and Docker Compose.
- Built and deployed EdgeTunnel from `~/edgev2.1`, with persistent settings
  and the small-VM resource limits.
- Generated admin credentials in the VM's `.env`.
- Configured Caddy to provide trusted HTTPS for the public IP and redirect
  HTTP to HTTPS.
- Verified admin login, subscriptions, all 30 tests, and real VLESS Internet
  traffic.
- Preserved the existing OpenVPN service on UDP port 1194.

EdgeTunnel is a self-hosted proxy on an Azure VM. The existing OpenVPN
service is a separate deployment.

## Deployment details

| Item | Recorded value |
| --- | --- |
| VM public IP | `<VM_PUBLIC_IP>` |
| SSH account | `<VM_USER>` |
| Repository on VM | `/home/<VM_USER>/edgev2.1` |
| Admin page | `https://<VM_PUBLIC_IP>/admin` |
| Internal EdgeTunnel address | `http://127.0.0.1:8080` |
| Public HTTPS proxy | Caddy |
| Desktop HTTP/SOCKS proxy | `127.0.0.1:10808` |
| VM Compose wrapper | `/home/<VM_USER>/.config/edgetunnel/compose` |

Initially, public access failed because EdgeTunnel only listened on
`127.0.0.1:8080`. Caddy resolved this by forwarding public HTTPS traffic to
EdgeTunnel. The final setup redirected port 80 to HTTPS on port 443.

## Setup procedure

The following procedure reconstructs the recorded deployment using the
repository's current Compose files. It is not an exact transcript of the
original commands. The VM-only HTTPS files and wrapper below reproduce the
described configuration; the originals are not included in this repository.
The package installation example assumes Ubuntu. The VM already existed
and already had OpenVPN installed.

### 1. Connect to the VM and allow the required ports

On your **Linux desktop**, replace the placeholders and connect:

```bash
VM_PUBLIC_IP='<VM_PUBLIC_IP>'
VM_USER='<VM_USER>'
SSH_KEY_PATH='<SSH_PRIVATE_KEY_PATH>'
ssh -i "$SSH_KEY_PATH" "${VM_USER}@${VM_PUBLIC_IP}"
```

The recorded session used tmux to keep the SSH terminal available. An
existing tmux session can be reused; tmux is not required for the service.

In the Azure network security group attached to the VM or its subnet,
ensure these inbound rules permit the required traffic. If a host firewall
is active, check its rules too.

| Destination port | Protocol | Purpose |
| --- | --- | --- |
| 22 | TCP | SSH; restrict the source to your trusted desktop/network |
| 80 | TCP | Public HTTP redirect and certificate validation |
| 443 | TCP | Public HTTPS, WebSocket traffic, and certificate validation |
| 1194 | UDP | Preserve the existing OpenVPN rule and service |

Keep EdgeTunnel's host port 8080 bound to loopback. Clients reach Caddy on
443, and Caddy reaches `tunnel:8080` over the Docker network. The Azure
public IP belongs in the public URL, not in `BIND_ADDRESS`.

### 2. Install Docker Engine and Compose

Run this and the remaining server commands **on the VM**. If Docker and
Compose already work, skip installation. For a fresh Ubuntu installation,
add Docker's official package repository:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

These commands follow the [official Docker Ubuntu installation guide](https://docs.docker.com/engine/install/ubuntu/).
For a different distribution or an existing conflicting Docker installation,
use the matching instructions in that guide.

### 3. Put the repository on the VM and generate credentials

For a new checkout, replace the repository URL placeholder:

```bash
REPOSITORY_URL='<REPOSITORY_URL>'
git clone "$REPOSITORY_URL" "$HOME/edgev2.1"
cd "$HOME/edgev2.1"
```

If the repository is already present, use `cd "$HOME/edgev2.1"` instead.
Set the public IP again in this VM shell; desktop shell variables are not
automatically passed through SSH.

```bash
VM_PUBLIC_IP='<VM_PUBLIC_IP>'
sudo docker build -t edgetunnel-self-hosted:local .
sudo docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD,target=/setup" \
  edgetunnel-self-hosted:local node self-host/setup.js \
  --url "https://${VM_PUBLIC_IP}" --bind 127.0.0.1 --output /setup/.env
chmod 600 .env
```

The setup command generates random `ADMIN`, `UUID`, and `KEY` values and
sets `PUBLIC_URL`, `VPN_DOMAIN`, and the loopback binding. It refuses to
overwrite an existing `.env`. For an existing deployment, keep the existing
credentials and edit only the address settings as needed:

```dotenv
PUBLIC_URL=https://<VM_PUBLIC_IP>
VPN_DOMAIN=<VM_PUBLIC_IP>
BIND_ADDRESS=127.0.0.1
HTTP_PORT=8080
```

Keep `.env`, private SSH keys, node links, and subscription URLs private.
The repository already ignores `.env`; do not paste its contents into this
public summary. Settings persist in the `tunnel_data` Docker volume.

### 4. Configure trusted HTTPS for the public IP

The repository's default `deploy/Caddyfile` is for the domain-based HTTPS
setup. This reconstruction explicitly selects Let's Encrypt's `shortlived`
ACME profile for a public-IP certificate, using Caddy's
[ACME issuer configuration](https://caddyserver.com/docs/caddyfile/directives/tls)
and the [Let's Encrypt profile documentation](https://letsencrypt.org/docs/profiles/).
Those certificates last about six days, so leave Caddy running for renewal.

Keep the VM configuration outside the public checkout:

```bash
mkdir -p "$HOME/.config/edgetunnel"
cat > "$HOME/.config/edgetunnel/Caddyfile" <<'EOF'
https://{$VPN_DOMAIN} {
    tls {
        issuer acme {
            dir https://acme-v02.api.letsencrypt.org/directory
            profile shortlived
        }
    }
    reverse_proxy tunnel:8080
}

http://{$VPN_DOMAIN} {
    redir https://{$VPN_DOMAIN}{uri} permanent
}
EOF

cat > "$HOME/.config/edgetunnel/compose.ip-https.yaml" <<EOF
services:
  caddy:
    volumes:
      - "$HOME/.config/edgetunnel/Caddyfile:/etc/caddy/Caddyfile:ro"
EOF
```

The last Compose file replaces Caddy's configuration mount while retaining
its existing ports, certificate volumes, and resource limits. Caddy's
`caddy_data` volume retains the certificate and renewal state. Use a current
Caddy image supporting `profile`; certificate issuance also requires a
reachable public IP and open validation ports.

### 5. Create the Compose wrapper and start the services

Create a wrapper that always uses the same repository, `.env`, and five
Compose files, even when called from another directory:

```bash
cat > "$HOME/.config/edgetunnel/compose" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec sudo docker compose \
  --project-directory "$HOME/edgev2.1" \
  --env-file "$HOME/edgev2.1/.env" \
  -f "$HOME/edgev2.1/compose.yaml" \
  -f "$HOME/edgev2.1/compose.https.yaml" \
  -f "$HOME/edgev2.1/compose.small-vm.yaml" \
  -f "$HOME/edgev2.1/compose.small-vm.https.yaml" \
  -f "$HOME/.config/edgetunnel/compose.ip-https.yaml" \
  "$@"
EOF
chmod 700 "$HOME/.config/edgetunnel/compose"

~/.config/edgetunnel/compose config --quiet
~/.config/edgetunnel/compose pull caddy
~/.config/edgetunnel/compose run --rm --no-deps caddy \
  caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null
~/.config/edgetunnel/compose up -d --no-build
```

The small-VM overrides cap the tunnel at 192 MiB and Caddy at 96 MiB,
with runtime memory tuning and rotating logs. The wrapper retains these
overrides for subsequent operations. Keep the same Compose project name
and volumes if adapting this to an existing installation.

### 6. Verify the server, then connect a client

On the **VM**, check container status, recent Caddy logs, and local health:

```bash
~/.config/edgetunnel/compose ps
~/.config/edgetunnel/compose logs --tail=100 caddy
curl --noproxy '*' --fail http://127.0.0.1:8080/healthz
```

On your **Linux desktop**, using the variables from step 1, check the HTTP
redirect and trusted HTTPS access without bypassing certificate validation:

```bash
curl --noproxy '*' --head "http://${VM_PUBLIC_IP}/admin"
curl --noproxy '*' --fail --output /dev/null \
  "https://${VM_PUBLIC_IP}/admin"
```

Expect HTTP to redirect to HTTPS and HTTPS to complete successfully. If
certificate issuance fails, inspect Caddy logs and the Azure/host firewall
rules before importing a node link.

The recorded session also passed all 30 application tests. To run the tests
from the image built in step 3, run this **on the VM**:

```bash
sudo docker run --rm edgetunnel-self-hosted:local npm test
```

The number of tests can change as the repository evolves. Finally, follow
the client and desktop/terminal proxy steps below, check admin login and
subscription import, and verify that proxy traffic exits through the VM.
The recorded session verified real VLESS Internet traffic. Confirm the
existing OpenVPN connection still works after deployment.

## Connect with v2rayN or V2Box

1. Open `https://<VM_PUBLIC_IP>/admin` using your VM's public IP.
2. Log in using the admin password saved in the VM's `.env`.
3. Click **Copy node**.
4. Import the complete `vless://…` link into v2rayN or V2Box and connect.
5. Keep the client running.

Import the node link, rather than the `/admin` page URL.

To retrieve the admin password, run this **on the VM**:

```bash
sed -n '/^ADMIN=/p' ~/edgev2.1/.env
```

## Enable the proxy for GNOME desktop applications

During troubleshooting, Xray's HTTP and SOCKS proxy was verified at
`127.0.0.1:10808`. GNOME already had those addresses configured, but its
proxy mode was off.

Run this **on your Linux desktop** to enable the existing configuration:

```bash
gsettings set org.gnome.system.proxy mode 'manual'
```

Keep v2rayN running and restart the affected desktop applications.
The settings are also available through **Settings → Network → Network
Proxy → Manual**.

To disable GNOME proxying:

```bash
gsettings set org.gnome.system.proxy mode 'none'
```

GNOME proxy settings affect applications that honor them. Full-device
routing requires a compatible client's TUN mode; it was not configured or
verified during this setup.

## Enable the proxy for terminal applications

Add these lines to `~/.bashrc` **on your Linux desktop**:

```bash
export http_proxy="http://127.0.0.1:10808"
export https_proxy="$http_proxy"
export ALL_PROXY="socks5h://127.0.0.1:10808"
export no_proxy="localhost,127.0.0.1,::1"
```

Apply the settings to the current Bash terminal:

```bash
source ~/.bashrc
```

Keep v2rayN running. These variables affect applications that support proxy
environment variables; they do not force every application through the
proxy. See the [curl environment-variable documentation](https://curl.se/libcurl/c/libcurl-env.html).

### Verify the outgoing IP

Test the local proxy explicitly:

```bash
curl --proxy http://127.0.0.1:10808 --max-time 15 https://api.ipify.org
echo
```

Test whether the terminal's environment settings are being used:

```bash
curl --max-time 15 https://api.ipify.org
echo
```

The successful proxy test returned the VM's outgoing public IP.
The direct connection returned a different public IP during that session;
these addresses have been omitted for privacy.

## Manage the VM deployment

Connect from your Linux computer after setting `SSH_KEY_PATH`, `VM_USER`,
and `VM_PUBLIC_IP` to your own values:

```bash
ssh -i "$SSH_KEY_PATH" "${VM_USER}@${VM_PUBLIC_IP}"
```

Then run these commands **on the VM**:

```bash
# Check containers
~/.config/edgetunnel/compose ps

# Start the configured deployment
~/.config/edgetunnel/compose up -d --no-build

# Read recent logs
~/.config/edgetunnel/compose logs --tail=100
```

The wrapper includes the base Compose configuration, HTTPS configuration,
small-VM overrides, and the VM-specific IP HTTPS override. Use it to retain
the configuration deployed during our session.

## Optional Cloudflare Tunnel domain

Cloudflare Tunnel was discussed but was not installed or configured.

If `cloudflared` runs directly on the VM, configure:

| Setting | Value |
| --- | --- |
| Public hostname | Your domain, such as `vpn.example.com` |
| Service type | HTTP |
| Service URL | `127.0.0.1:8080` |
| Full origin URL | `http://127.0.0.1:8080` |

Cloudflare maps the public hostname to the local service. See the
[Cloudflare routing documentation](https://developers.cloudflare.com/tunnel/concepts/routing/).

Update these values in the VM's `~/edgev2.1/.env`, replacing the example
domain with your actual hostname:

```dotenv
PUBLIC_URL=https://vpn.example.com
BIND_ADDRESS=127.0.0.1
HTTP_PORT=8080
```

Apply the configuration:

```bash
~/.config/edgetunnel/compose up -d --no-build tunnel
```

Once the Cloudflare Tunnel route is configured, open your domain's `/admin`
page and re-import the generated node link. Traffic arriving through
Cloudflare Tunnel bypasses Caddy.

If `cloudflared` runs inside Docker, connect it to `edgev21_default` and use
`http://tunnel:8080` as the origin. A container's `localhost` refers to that
container, rather than the VM or the EdgeTunnel container.

## Limitations and unfinished work

- **Codex CLI proxying remained unresolved.** The browser and explicit curl
  proxy tests worked, but the Codex background process lacked proxy
  variables. Updating `.bashrc` does not change an already-running process's
  environment. A complete CLI fix was not verified in the recorded session.
- **General UDP forwarding is unsupported by EdgeTunnel.** This deployment
  uses TCP over WebSocket, with TLS for public HTTPS connections. The
  separate OpenVPN service uses UDP port 1194.
- **Full-device routing was not configured.** GNOME settings and terminal
  proxy variables cover applications that honor those settings.
- **Cloudflare Tunnel was not deployed.** The instructions above record the
  proposed domain setup.
- **Small-VM performance validation remained incomplete.** The final saved
  benchmark comparison, complete sustained-load report, and validation on
  an actual 512 MiB VM were not confirmed. Passing functional tests does
  not establish those performance targets.
