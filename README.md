# TestMW Browser Host

A **thin local agent** that lets [TestMW](https://testmw.ru) drive a browser
running **inside your own network** — your server, your laptop, or a machine
behind a corporate VPN that has no inbound access from the internet.

You run this agent next to the app you want to test. TestMW connects to the
browser it launches, through a relay, and executes your scenarios there — so
the tested site sees traffic from **your** network (internal hosts, staging
behind a VPN, IP allow-lists, geo-restricted environments), not from TestMW's
cloud.

> **What stays where.** This agent is *only* a browser provider. It launches a
> standard Playwright browser server and bridges its WebSocket endpoint to the
> relay. All test logic — the scenario actions, AI scenario generation, and
> failure analysis — runs on the TestMW server and is **never** shipped to this
> agent. There is no proprietary logic in this repository.

---

## How it works

1. The agent opens a single **outbound** WSS connection (port 443) to the relay
   and registers using your account token. No inbound ports are required — this
   is what makes it work behind NAT/VPN/firewalls.
2. When you start a test, preview, or recording bound to your host, the relay
   asks the agent to `launch` a browser.
3. The agent runs `chromium.launchServer()` locally and opens an outbound data
   channel to the relay.
4. The TestMW worker does `chromium.connect()` through the relay and runs the
   scenario in your browser.

If WebSocket is blocked by deep-packet inspection, the agent automatically
degrades to HTTPS long-polling. Standard `HTTPS_PROXY` / `NO_PROXY` variables
and TLS-inspection (MITM) corporate proxies are supported out of the box.

---

## Requirements

- **Node.js ≥ 20** (for the bare-metal install), or **Docker** (recommended).
- Outbound HTTPS (443) reachability to the TestMW relay.
- A TestMW account and a personal API token.

---

## Quick start (Docker — recommended)

```bash
git clone https://github.com/mikapr/testmw_browser_host.git
cd testmw_browser_host
cp .env.example .env
# edit .env and paste your WORKER_TOKEN

docker compose up -d
docker compose logs -f
```

You should see `Channel is up (ws)` and, in the TestMW dashboard, your host
listed as **online**.

To run without compose:

```bash
docker build -t testmw-browser-host .
docker run -d --name testmw_browser_host --restart unless-stopped \
  --shm-size=1g \
  -e WORKER_TOKEN=your-token-here \
  testmw-browser-host
```

## Quick start (Node.js)

```bash
git clone https://github.com/mikapr/testmw_browser_host.git
cd testmw_browser_host
npm install            # also downloads Chromium via postinstall
cp .env.example .env   # paste your WORKER_TOKEN
npm start
```

---

## Getting your token

1. Open the TestMW dashboard → **Profile → API tokens**.
2. Create a token (or reuse an existing one) and copy it.
3. Put it in `.env` as `WORKER_TOKEN=...`.

The token binds this agent to your account. Revoking the token in the dashboard
immediately cuts the host off — it can no longer connect.

Then, in the test editor / recorder / preview, enable **"Run on my own
browser"** to route that work to your host.

---

## Configuration

All configuration is via environment variables (or `.env`). Sensible defaults
mean you usually only need `WORKER_TOKEN`.

| Variable             | Default                          | Description                                                        |
| -------------------- |----------------------------------| ------------------------------------------------------------------ |
| `WORKER_TOKEN`       | — (**required**)                 | Account-binding token from the TestMW dashboard.                   |
| `RELAY_URL`          | `wss://www.testmw.ru/relay/host` | TestMW relay address. Keep `wss://` on 443 unless self-hosting.    |
| `HOST_NAME`          | machine hostname                 | Display name in the dashboard's online-hosts list.                 |
| `TRANSPORT_MODE`     | `auto`                           | `auto` (WS→polling), `ws`, or `polling`.                           |
| `HEADLESS`           | `true`                           | Set `false` to watch the browser locally while debugging.          |
| `MAX_SESSIONS`       | `4`                              | Cap on simultaneous browsers on this machine.                      |
| `BROWSER_ARGS`       | —                                | Extra comma-separated Chromium CLI args.                           |
| `LOG_LEVEL`          | `info`                           | `error`, `warn`, `info`, or `debug`.                               |

### Behind a corporate proxy / VPN

The agent reads the standard proxy variables, just like curl or git:

```bash
HTTPS_PROXY=http://proxy.corp.local:8080
NO_PROXY=.internal,localhost
```

For **TLS-inspecting** proxies (a MITM appliance with its own CA), trust the
corporate CA instead of disabling verification:

```bash
NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem
```

The agent does **not** pin certificates, so TLS-inspection environments work
without extra flags. `TLS_INSECURE=1` exists for debugging only — do not use it
in production.

---

## Operating notes

- **Isolation:** each task launches its own browser server, then tears it down —
  no shared state between runs.
- **Stay running:** under Docker, `restart: unless-stopped` (compose) or
  `--restart unless-stopped` handles crashes and reboots. For a bare-metal Node
  install, run it under `systemd` or `supervisor`.
- **Multiple hosts:** run several agents (different `HOST_NAME`, same or
  different tokens) to spread load or to reach different networks.
- **Resource sizing:** Chromium needs a large `/dev/shm`. The provided compose
  file sets `shm_size: 1gb`; pass `--shm-size=1g` with `docker run`.

---

## Security

How the channel is protected:

- Only **outbound** connections are made — the agent never opens a listening
  port. Nothing inbound is exposed to the internet.
- The relay authenticates every worker connection with a short-lived,
  HMAC-signed, single-purpose session token; the signature, expiry, and **host
  ownership** are all verified before any browser is launched. A token minted
  for one account can never reach another account's host.
- The data channel cannot be hijacked: it is bound to the exact session and to
  the same credentials as the host's control channel.
- The agent ships no test logic, credentials, or analysis code — it only
  forwards Playwright protocol frames.
- Revoking your token in the TestMW dashboard immediately cuts the host off.

### ⚠️ Important: the browser runs inside *your* network — you are responsible for what it can reach

By design, this agent launches a browser **inside the network where you run
it**, and TestMW drives that browser to execute *your* scenarios. That browser
can therefore reach **anything that machine can reach** — internal services,
admin panels, private IP ranges (`10.0.0.0/8`, `192.168.0.0/16`,
`169.254.169.254` cloud metadata), `file://` URLs, and so on.

The agent does **not** restrict navigation targets. Where the browser goes is
determined entirely by the scenarios you run on your account. **Controlling that
exposure is your responsibility**, not the agent's. We strongly recommend:

- **Run the host on a dedicated, network-segmented machine** with only the
  access your tests actually need — not on a box that can reach your whole
  internal network. Treat it like any other internet-facing component.
- **Run it under a least-privileged OS user** (the provided Docker setup already
  isolates the process; do not run it as root with broad network access).
- **Keep your TestMW account secure** (strong password, 2FA). Anyone who can
  create or edit tests on your account can navigate this browser into your
  network.
- **Keep `WORKER_TOKEN` secret** — it binds the agent to your account. It lives
  in `.env` (git-ignored). If it leaks, revoke it in the dashboard at once.
- **Scope the network at the firewall**, not just in the agent: allow the host
  egress only to the targets you intend to test, and block cloud-metadata
  endpoints if you run on a cloud VM.
- **Stop the agent when you are not running tests** if the host sits in a
  sensitive segment — no running agent, no channel.

In short: the agent is a faithful conduit. It does exactly what your scenarios
tell the browser to do, from inside your network. Decide carefully where you run
it and what that machine is allowed to reach.

---

## License

Released under the [MIT License](LICENSE).
