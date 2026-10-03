# Small-VM deployment and performance plan

Status: implemented; functional and isolated Compose checks pass. Sustained
load testing and final baseline comparison are in progress. Actual
512 MiB VM validation remains necessary. See `SMALL_VM_RESULTS.md`.

## Goal and scope

Optimize the existing self-hosted VPN proxy for a Linux VM with **1 vCPU and
512 MiB RAM**, serving **1–5 personal devices** through Docker Compose.
Keep the English admin interface, persistent configuration, and existing
VLESS, Trojan, and Shadowsocks-over-WebSocket clients. Do not replace the
proxy engine with Xray or change client-link formats.

Aim for 100 Mbps where the VM's CPU and network support it. This is a
measurement target, not a guaranteed speed. The existing deployment was
observed using approximately 26 MiB while idle; that observation is not a
small-VM load test.

Leave the running deployment untouched while developing and testing. Use
isolated test containers, ports, and volumes. Preserve `.env`, credentials,
saved settings, and unrelated repository changes. All new warnings,
messages, and documentation must be in English.

## Implementation

### 1. Opt-in deployment profile

- Add `compose.small-vm.yaml` and `RUNTIME_PROFILE=small-vm`.
- Limit the tunnel container to 192 MiB, with a 96 MiB JavaScript heap.
  The heap limit is not a total-process memory limit: buffers and native
  allocations also consume memory.
- Limit Caddy to 96 MiB when the optional HTTPS deployment is used.
  Ensure the LAN-only profile does not inadvertently start Caddy; use a
  separate HTTPS resource override if necessary.
- Leave memory available for Linux and Docker. Verify resource settings
  in the effective Compose configuration and running test containers.
- Preserve existing volume names and credentials. Keep the profile optional
  and document rollback by removing its override files.
- Use the official Node.js 22 Alpine image to reduce installation size,
  retaining the existing JavaScript dependencies.
- Replace the health check's `fetch` initialization with a lightweight
  Node HTTP request, checking the response status and handling failures.

### 2. Connection and authentication limits

- Allow at most 128 concurrent tunnels, counting pending upgrades as well
  as established WebSocket connections.
- Reject excess connections with an English capacity message.
- Set the maximum WebSocket message size to 512 KiB.
- Close connections that do not authenticate within 10 seconds.
- Recognize authentication only after validating the protocol credentials;
  receiving a partial Shadowsocks handshake must not disable the timeout.
- Release connection slots and timers on every rejection, error, disconnect,
  and shutdown path.

### 3. Inbound backpressure and queue accounting

- Pause WebSocket input when a connection's queued and processing bytes
  reach 256 KiB; resume below 64 KiB.
- Enforce a hard 1 MiB per-connection inbound queue limit.
- Enforce a shared 32 MiB inbound queue budget across tunnels.
- Count both queued messages and the message currently being processed;
  do not subtract bytes before the corresponding processing completes.
- Use `ws.pause()` and `ws.resume()` in the local runtime adapter.
- Retain a bounded message-count limit so tiny messages cannot create an
  unbounded number of pending tasks.
- Release reservations on all error and close paths without double release.
  Ensure queued data does not remain retained after a failed connection.
- Keep TCP writes and WebSocket sends backpressured; avoid introducing
  additional unbounded buffers outside the explicit queue budget.

### 4. Lower-latency forwarding

- For local TCP responses, forward each available chunk immediately and
  await completion of its WebSocket send before reading the next chunk.
- Bypass the existing small-response batching timers in the local runtime.
- Remove unnecessary buffer copies where ownership and lifetime are safe.
- Preserve the initial VLESS response header, Shadowsocks encryption,
  chained-proxy handling, and fallback behavior.
- Skip UUID derivation when a valid fixed UUID is available.
- Keep direct TCP dialing at one attempt, WebSocket compression disabled,
  stored request logging disabled, and debug output disabled in the
  small-VM profile.
- Keep runtime-specific changes isolated from Cloudflare Worker behavior.

## Verification

### Functional and safety tests

- Keep all 11 existing integration tests passing, covering authentication,
  admin settings, subscriptions, persistence, early data, IPv6, and real
  TCP traffic through VLESS, Trojan, and Shadowsocks.
- Add tests for slow receivers and blocked TCP destinations, pause/resume
  thresholds, per-connection and global queue limits, oversized messages,
  capacity rejection, and authentication timeout.
- Test disconnects while messages are queued or processing, including
  counter cleanup, timer cleanup, and reuse of released capacity.
- Build and start the Docker image with the small-VM profile. Check login,
  health, persisted settings after restart, and forwarding through Caddy.
- Do not expose passwords, UUIDs, subscription tokens, or full environment
  dumps in test output or reports.

### Performance measurements

Compare the existing baseline and optimized implementation on identical
hardware and with the same test parameters. Record the image versions and
resource limits so results are reproducible.

Measure:

1. Raw TCP throughput as the network/CPU reference.
2. Upload and download through VLESS, Trojan, and Shadowsocks.
3. VLESS over HTTPS through Caddy.
4. One active stream and five simultaneous streams.
5. Memory usage with 64 authenticated idle tunnels.
6. Connection churn and recovery after slow-client disconnections.
7. A 30-minute sustained-load run.

Record throughput, CPU usage, peak container memory, p95 request latency,
errors, container restarts, and OOM events. Where practical, keep load
generation outside the resource-limited server container.

Acceptance targets:

| Metric | Target |
| --- | --- |
| Combined tunnel and Caddy idle memory | Below 96 MiB |
| Combined tunnel and Caddy load memory | Below 256 MiB |
| Stability | No OOM events or unexpected restarts |
| Throughput | At least 100 Mbps when raw TCP reaches at least 125 Mbps, and at least 80% of the corresponding raw TCP baseline |
| Added p95 request latency | Below 5 ms in a controlled local comparison |

Container-limited testing is an initial check, not proof of performance on
a real 512 MiB VM. Final validation on that VM remains necessary. Report
failed targets and unavailable measurements explicitly; do not substitute
estimates for measurements.

## Deployment and rollback

After verification, document the exact Compose commands in
`SELF_HOSTING.md`. The intended LAN command is:

```bash
docker compose -f compose.yaml -f compose.small-vm.yaml up -d --build
```

For public HTTPS, also include `compose.https.yaml` and any separate
small-VM HTTPS resource override. Retain the existing domain, certificate,
and port-forwarding requirements. Plain WebSocket remains suitable only
for trusted LAN use; VLESS does not encrypt that transport by itself.

For resource-profile rollback, run Compose with the original override set,
omitting the small-VM files. For a full implementation rollback, retain a
known-good baseline image and recreate the service with that image. Never
remove configuration volumes as part of rollback. Refresh client links
only if the public endpoint or transport settings actually change.

## Out of scope

- Replacing the proxy engine or selecting another hosting provider.
- General UDP support, gRPC, or XHTTP implementation.
- Kernel/network tuning or privileged containers.
- Changing credentials, deleting volumes, or redeploying the live service
  during development.
- Guaranteed speeds independent of VM CPU, uplink, routing, or clients.

## Completion checklist

- [x] Small-VM Compose profile and HTTPS memory limits implemented.
- [x] Alpine image and lightweight health check implemented.
- [x] Connection, message-size, and authentication limits implemented.
- [x] Queue budgets, backpressure, and cleanup implemented.
- [x] Immediate local forwarding and fixed-UUID optimization implemented.
- [x] Existing and new functional tests pass.
- [x] Isolated Docker and Caddy checks pass.
- [ ] Baseline comparison and sustained-load measurements recorded.
- [x] Deployment and rollback instructions updated.
- [x] Results and actual-VM validation limitations documented.
