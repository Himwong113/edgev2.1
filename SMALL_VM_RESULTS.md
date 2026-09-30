# Small-VM validation results

Status: implementation and functional checks complete; the sustained-load
test and final baseline comparison are in progress. This is **not** a test
on an actual 512 MiB VM.

## Test environment and method

- Date: 2026-09-30.
- Host: Linux x86-64, Intel Core i5-13400F, 16 logical CPUs, approximately
  64 GiB RAM. Other existing host services were left running.
- Tunnel: 192 MiB memory/swap cap, 96 MiB JavaScript heap, 1 CPU quota,
  and 64 PID/thread limit.
- Caddy: 96 MiB memory/swap cap, 64 MiB Go soft memory limit,
  `GOMAXPROCS=1`, and 64 PID/thread limit.
- For performance testing, the tunnel and Caddy are both pinned to host
  CPU 15, so their proxy work shares one logical CPU. The generator and
  raw TCP target run outside the limited containers.
- Direct loopback WebSocket and real Caddy HTTPS were tested with one
  stream and five simultaneous streams. Each stream transfers 8 MiB.
  Shadowsocks uses AES-128-GCM with correctly carried little-endian nonces.
- Latency uses 64-byte TCP echo requests over established connections,
  excludes five warm-up requests, and reports p95 of the next 100.
- The sustained test alternates upload/download across VLESS, Trojan,
  Shadowsocks, and VLESS through Caddy, with five active streams and
  64 additional authenticated idle VLESS connections.
- CPU and memory are sampled from Linux cgroup v2 every five seconds.
  `memory.peak` is also recorded; it covers the container's lifetime,
  including startup and health-check processes. Summing the two containers'
  individual memory peaks is a conservative combined upper bound, not
  necessarily a simultaneously observed total.

The baseline image is `edgetunnel-self-hosted:small-vm-baseline` (Node.js
22.23.3, Bookworm); the optimized load-test image uses Node.js 22.22.2,
Alpine. The different base OS/Node patch versions, short samples, CPU
frequency variation, and shared host are comparison limitations. This
measures the whole deployment change, not just one isolated code edit.

Recorded image IDs:

- Baseline: `sha256:1bf617e650d0fc0a0a151fe8cd492da15b4bc80d896dfacaa4824217a3797e27`.
- Optimized load artifact: `sha256:044866d4e1b1fabe375ff2c71fe3a55a6cb690a96a7cb653003efa0899830330`.

The final smoke-tested image will be recorded after validation. Additional
upgrade-rejection/close hardening was added after the load artifact was
built; its core queue and forwarding implementation is unchanged.

## Functional checks

- All 30 unit/integration tests pass. They include the original 11 tests,
  queue accounting and budget cleanup, pause/resume, capacity reuse,
  message-size rejection, authentication timeout, blocked TCP receivers,
  slow WebSocket clients, and a 3 MiB many-record Shadowsocks echo transfer.
- A regression test verifies that a destination closing before its first
  response cannot crash the application through an unhandled fallback
  rejection.
- `npm run test:docker` passed isolated Compose startup, English login,
  TLS client-link generation, persisted settings after restart, a real
  256 KiB VLESS transfer through Caddy HTTPS, and effective resource limits.
- The verification project and its temporary volumes were removed;
  the original live VPN and its credentials were not changed.
- The LAN-only Compose profile contains only the tunnel service.

## Performance

Final results, acceptance-target outcomes, and baseline comparison will be
filled in when the 30-minute run completes. Initial optimized measurements
are all above 100 Mbps; they are not Internet/VM speed guarantees.

Early development benchmark runs with a faulty test-client nonce carry
were excluded. The client was corrected and a long-stream regression
test was added; those failed development runs are not throughput results.

## Reproducing the checks

Functional checks:

```bash
npm ci
npm test
docker build -t edgetunnel-self-hosted:small-vm-test .
npm run test:docker
```

The Docker check requires a local Docker engine and Compose 2.24.4 or later.
It uses the separate `edgetunnel-smallvm-verify` project, internal localhost
certificates, ephemeral loopback ports, and synthetic credentials. It
refuses to touch an existing verification project.

For a performance run, create a separate test tunnel container from the
test image, with the limits above, an explicit test UUID, and a loopback
published HTTP port. Use a separate Caddy container for HTTPS; pin both
to the same available CPU if approximating a one-CPU server. Do not use
your production admin password, UUID, endpoint, volume, or image tag.

Then run the harness, replacing the example ports, host gateway, UUID,
and container names with the isolated test values:

```bash
BENCHMARK_UUID=YOUR_TEST_UUID npm run benchmark -- \
  --endpoint ws://127.0.0.1:TEST_HTTP_PORT \
  --target-host DOCKER_HOST_GATEWAY_IPV4 \
  --tls-endpoint wss://localhost:TEST_HTTPS_PORT \
  --insecure-test-tls \
  --containers TEST_TUNNEL,TEST_CADDY \
  --bytes 8388608 --duration 1800 --label optimized
```

The harness creates a temporary TCP target on the host, checks transfer
lengths/content, measures raw TCP and proxy throughput, measures established
connection latency, opens 64 idle tunnels, churns 100 connections, then
runs the requested sustained load. It prints progress and a sanitized
`BENCHMARK_REPORT` JSON summary without credentials. Container monitoring
requires Linux cgroup v2. Run the baseline separately with the same
hardware, limits, transfer size and CPU affinity.

`--insecure-test-tls` is solely for the isolated internal-CA localhost
test. It must not be used as a production-client TLS configuration.
The CLI refuses non-loopback proxy endpoints, but you must still ensure
the chosen loopback port belongs to your isolated test server.

## Remaining real-world validation

- Run on the actual 1 vCPU / 512 MiB VM, including its OS and Docker memory
  overhead. Container caps on this larger host are not proof of VM capacity.
- Measure the real uplink and destination route, not loopback capacity.
- Verify public DNS, router forwarding, publicly trusted TLS issuance,
  and actual V2Ray/V2Box client imports and traffic on your devices.
- Monitor health, CPU, memory, queue-limit disconnects, and client behavior
  under your normal workload. There is no general UDP/gRPC/XHTTP expansion
  or comprehensive public-facing abuse protection in this change.
