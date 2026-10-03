# How this repository keeps the VPN proxy light and responsive

This repository's self-hosted EdgeTunnel deployment is designed for a
small Linux VM: **1 vCPU, 512 MiB RAM, and 1–5 personal devices**. It reduces
background work, controls how much traffic can wait in memory, and forwards
responses without the batching delays used in the Cloudflare runtime.

These changes help conserve resources and keep the service responsive
under load. They do not guarantee faster Internet speeds. The recorded
performance target is 100 Mbps where the CPU and network support it;
the final baseline comparison and actual 512 MiB VM validation remain
unfinished in [the saved results](./SMALL_VM_RESULTS.md).

## How traffic travels

The self-hosted service is a client proxy. It supports VLESS, Trojan, and
Shadowsocks over WebSocket. A client's system proxy or TUN mode determines
which applications use it. General UDP forwarding is unsupported, and
the existing OpenVPN service is a separate deployment.

For the public HTTPS setup:

```mermaid
flowchart LR
    A[Application] --> B[v2rayN or V2Box]
    B -->|WebSocket over TLS| C[Caddy on port 443]
    C -->|Docker network| D[Node.js EdgeTunnel]
    D -->|Outbound TCP| E[Destination server]
```

Caddy handles the public TLS connection. EdgeTunnel authenticates the
client, processes its proxy protocol, and opens the destination connection.
The normal self-hosted route uses direct TCP egress; an explicitly
configured chained proxy adds another hop. The application can also have
its own end-to-end HTTPS connection inside the tunnel.

## 1. A smaller installation and less background work

| Implementation | What it saves | Where to find it |
| --- | --- | --- |
| `node:22-alpine` image | A smaller base installation than a full Debian-based image; image size alone does not establish lower runtime RAM or faster traffic | [Dockerfile](./Dockerfile) |
| Production dependencies only and cleaned npm cache | Avoids installing development dependencies and retaining the package download cache in the image | [Dockerfile](./Dockerfile) |
| Local file storage in a persistent volume | Keeps settings without requiring a separate database service | [compose.yaml](./compose.yaml), [storage.js](./self-host/storage.js) |
| Lightweight HTTP health check | Checks `/healthz` with Node's HTTP module instead of initializing `fetch` in each health-check process | [healthcheck.js](./self-host/healthcheck.js) |
| Stored request logging and debug output disabled | Reduces routine disk writes, formatting, and diagnostic work in the small-VM profile; errors can still appear in container logs | [server.js](./self-host/server.js) |
| Container log rotation | Bounds disk growth with two log files of up to 5 MB each per service | [compose.small-vm.yaml](./compose.small-vm.yaml), [HTTPS override](./compose.small-vm.https.yaml) |

The basic deployment runs one tunnel container. Public HTTPS adds Caddy.
The LAN-only small-VM override does not start Caddy by itself.

## 2. Memory limits leave room for the operating system

The optional Compose profile sets these limits:

| Setting | Tunnel | Caddy |
| --- | --- | --- |
| Total container memory cap | 192 MiB | 96 MiB |
| Swap allowed beyond that cap | None | None |
| Runtime memory tuning | 96 MiB JavaScript heap | 64 MiB Go soft memory limit |
| PID/thread cap | 64 | 64 |
| CPU tuning | At most 1 CPU | Go scheduler parallelism of 1 |

The two memory caps total **288 MiB**. They are maximums, not reservations
or measurements of normal usage. On a 512 MiB VM, that nominally leaves
224 MiB outside these two caps, but Linux, Docker, and any other services
still need memory. Actual VM validation is necessary.

The JavaScript heap is only part of Node's memory use. Network buffers,
native allocations, and other overhead also count against the container
cap. Caddy's Go memory setting is soft; the 96 MiB container cap is the
separate total limit. `GOMAXPROCS=1` is scheduler tuning, not a Docker CPU
quota for Caddy.

Caps protect the host from uncontrolled consumption. A cap set too low
can cause garbage collection pressure or an out-of-memory termination;
it does not automatically improve throughput. The application-level queue
controls below help the process stay within its available memory.

## 3. Backpressure prevents slow destinations from filling RAM

Suppose a client uploads quickly but the destination receives slowly.
Without flow control, incoming messages could accumulate in memory faster
than EdgeTunnel can forward them. More queued data would mean more memory
use and longer waiting times.

[limits.js](./self-host/limits.js) controls that queue:

| Control | Value | Behavior |
| --- | --- | --- |
| Pause incoming WebSocket data | At 256 KiB queued/processing per connection | Stops reading more input while existing work drains |
| Resume input | Below 64 KiB | Restarts input after enough space is available |
| Hard per-connection queue budget | 1 MiB | Closes a connection that exceeds the budget |
| Shared inbound queue budget | 32 MiB | Bounds accounted input across all tunnels |
| Maximum WebSocket message | 512 KiB | Rejects oversized individual messages |
| Queued/processing message-count limit | 4,096 per connection | Bounds bookkeeping even for very small messages |

For example, when one connection reaches 256 KiB of pending work,
EdgeTunnel pauses its WebSocket input. It processes the existing messages
and resumes input below 64 KiB. Using different pause and resume thresholds
avoids repeatedly switching at a single boundary.

The accounting includes the message currently being processed. Its bytes
are released only when processing finishes. On failure or disconnect,
queued references, socket resources, and timers are cleaned up so they do
not keep consuming capacity after the client leaves.

These budgets cover the application's accounted inbound queue, not every
buffer in Node, the operating system, or Caddy. They are also not transfer
size limits: a large file can pass through as many smaller messages.

## 4. Connection limits prevent idle handshakes from taking over

The self-hosted server allows at most **128 concurrent tunnels**, including
pending WebSocket upgrades. When capacity is full, a new upgrade receives
HTTP 503 instead of opening another tunnel.

A client must authenticate within **10 seconds**. Sending an incomplete
handshake does not remove that deadline. The server also uses heartbeat
checks to detect unresponsive WebSocket clients and releases capacity on
close and failure paths.

These controls protect memory and connection slots; they are not a claim
that 128 active transfers will perform well on one small VM. One device
can open many connections, so the tunnel limit is not a device count.
The same safeguards apply to the standard self-hosted profile too.

## 5. Responses are forwarded without local batching delays

The local branch of `connectStreams()` in [_worker.js](./_worker.js)
reads an available TCP response chunk and sends it immediately through
the WebSocket. It bypasses the Cloudflare-specific batching path.

It then **waits for the WebSocket send to complete before reading the next
chunk**. [WorkerSocket.send()](./self-host/runtime.js) provides that awaitable
send operation. This reduces the chance of accumulating an uncontrolled
outbound send queue when the client is slow.

The local branch reuses response chunks where possible instead of making
additional batching copies. It still allocates when necessary, such as
when attaching the initial protocol response header. This reduces copying
work but is not an entirely zero-copy implementation.

The TCP connector also sets `setNoDelay(true)`, allowing small writes to
proceed without Nagle's coalescing delay. Immediate forwarding can reduce
small-response latency, although smaller sends can also mean more framing
and packet overhead. The overall effect must be measured.

## 6. Fewer connection attempts and less repeated CPU work

The `small-vm` runtime profile forces both `TCP_CONCURRENT_DIAL` and
`PROXY_CONCURRENT_DIAL` to `1`. This avoids duplicate concurrent dial
attempts and their extra sockets and connection work. It can trade away
the ability to race multiple attempts on an unreliable route; it is not
a limit of one active tunnel.

The server generates or loads a persistent UUID and passes it to the
proxy engine. When that valid fixed UUID is available, the engine skips
the password-derived UUID calculation for the request. This removes
some repeated setup work; it does not change bulk data encryption.

WebSocket compression is disabled with `perMessageDeflate: false` in
[server.js](./self-host/server.js). This avoids compression CPU and memory
overhead. Already encrypted application traffic usually has little useful
compressibility, although compressible plaintext could consume more
bandwidth with compression off.

## Enable the small-VM deployment profile

After creating `.env` and configuring the public endpoint as described in
[SELF_HOSTING.md](./SELF_HOSTING.md), use these commands from the repository
directory.

For a trusted LAN deployment:

```bash
docker compose -f compose.yaml -f compose.small-vm.yaml up -d --build
```

For the repository's domain-based public HTTPS deployment:

```bash
docker compose -f compose.yaml -f compose.https.yaml \
  -f compose.small-vm.yaml -f compose.small-vm.https.yaml up -d --build
```

For the recorded Azure public-IP HTTPS deployment, use the VM's wrapper
from [AZURE_VM_VPN_SUMMARY.md](./AZURE_VM_VPN_SUMMARY.md), which also includes
the VM-only IP certificate configuration:

```bash
~/.config/edgetunnel/compose up -d --build
~/.config/edgetunnel/compose ps
```

Keep the same override files when running later Compose commands, and
retain the same project name and persistent volumes. Setting only
`RUNTIME_PROFILE=small-vm` enables the application's profile behavior;
Docker memory, CPU, and log limits come from the Compose overrides.

For public access, retain trusted TLS. VLESS does not encrypt a plain
WebSocket transport by itself. The Azure setup guide keeps private values
as placeholders; this explanation includes no deployment credentials or
public IP addresses.

## What the recorded results establish

[SMALL_VM_RESULTS.md](./SMALL_VM_RESULTS.md) records 30 passing
unit/integration tests and passing isolated Docker/Caddy checks, including
real proxy traffic and verification of resource limits.

It reports initial optimized throughput measurements above 100 Mbps,
but does not contain the final baseline comparison or completed sustained
load results. Those initial tests ran on a larger host with container
limits, not an actual 512 MiB VM. Differences in base OS and Node patch
versions also limit attribution to any single optimization.

Consequently, the repository supports explaining **how overhead and queues
were reduced**, but it does not yet support a percentage speed improvement
or a guaranteed Azure/Internet throughput claim. The approximately 26 MiB
idle observation in [the plan](./SMALL_VM_PLAN.md) is also not a validated
small-VM load result.

For a fair performance comparison, the existing plan calls for the same
hardware and resource limits, a raw TCP reference, upload and download
through each protocol, one and five active streams, latency measurements,
64 authenticated idle tunnels, connection churn, and a 30-minute load run.
Track CPU, peak memory, errors, restarts, and out-of-memory events alongside
Mbps. The isolated benchmark instructions are in the results document.

The real connection's speed still depends on the client network, VM CPU
availability, VM uplink, route to the destination, destination performance,
and protocol/TLS work. Reducing proxy overhead helps only where that
overhead is a bottleneck; it cannot increase the capacity of those links.
