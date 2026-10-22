# VAS — VAS-as-supervisor

A web-based service manager for a single Linux host: **Podman**, **Podman Compose**, **LXC** and **libvirt VMs**, with an **OpenResty** reverse proxy that pulls its configuration from the manager and **acme.sh** issuing Let's Encrypt certificates over DNS-01 or DNS alias mode.

- Frontend: Vite + Preact (`web/`), i18n: English, 日本語, 한국어, 繁體中文, 简体中文
- Backend: Node.js + Fastify (`server/`); it drives the host through the standard CLIs (`podman`, `podman-compose`, `lxc-*`, `virsh`, `qemu-img`, `btrfs`, `ip`, `nft`, `dnsmasq`, `ss`, `git`)
- Containers: manager, OpenResty and acme.sh (`containers/`, `deploy/compose.yaml`)

```
              ┌────────────── host ───────────────────────────────────────┐
 browser ──▶  │ vas (manager, :8080)                                   │
              │   ├─ podman socket ──▶ containers / compose projects      │
              │   ├─ lxc-* (-P $VAS_LXC_DIR)                           │
              │   ├─ virsh ──▶ libvirtd ──▶ VMs (VNC/serial on 127.0.0.1)  │
              │   ├─ ip / nft / dnsmasq ──▶ per-instance bridges + subnets │
              │   └─ podman exec ──▶ vas-acme (acme.sh daemon)          │
              │                          │ reload hook (POST, token)       │
              │ vas-openresty ◀── Lua agent pulls bundle (GET, token)   │
              └───────────────────────────────────────────────────────────┘
```

## Requirement map

| # | Requirement | Where |
|---|---|---|
| 1 | Vite + Preact | `web/` |
| 2 | Podman / Podman Compose / LXC / VM | `server/src/modules/{podman,compose,lxc,vm}.ts`, pages `Containers`, `Compose`, `Lxc`, `Vms` |
| 3 | OpenResty component pulling forwarding settings | `containers/openresty/lua/vas/agent.lua` (privileged-agent timer → `GET /api/agent/openresty/bundle`), target picker lists podman ports / LXC / VM addresses |
| 4 | acme.sh Let's Encrypt, DNS + DNS alias, delivered to OpenResty | `server/src/modules/acme.ts` (`--dns`, `--challenge-alias`, `--domain-alias`, `--install-cert` + reload hook) |
| 5 | Automatic OpenResty config incl. Lua | `server/src/modules/openresty.ts` renders server/stream blocks, rate limiting via `resty.limit.req`, `access/header_filter/body_filter/log/content_by_lua_block`, global `init_worker` hook; agent runs `openresty -t`, rolls back on failure, HUPs on success |
| 6 | Certificates in web UI; noVNC; web serial | `Certificates` page; `VncViewer.tsx` (noVNC ↔ `/api/vms/:name/vnc`); `Terminal.tsx` (xterm.js ↔ libvirt TCP serial) |
| 7 | OpenResty, acme.sh and the tool in containers | `containers/vas/Containerfile`, `containers/openresty/Containerfile`, `neilpang/acme.sh` in `deploy/compose.yaml` |
| 8 | Passkey-only login, toggled by env | `server/src/modules/auth.ts`, `VAS_AUTH_ENABLED` |
| 9 | Data under env-configured dirs | `VAS_DATA_DIR` → `container/<name>`, `lxc/<name>`, `vm/<name>` (each overridable) |
| 10 | BtrFS subvolume per compose / LXC / VM folder | `server/src/modules/btrfs.ts`: filesystem auto-detected — subvolume (+ snapshots) only on btrfs, plain folder otherwise |
| 11 | Startup crash management and logging | `server/src/core/{boot,supervisor,instances,logger}.ts`: unclean-start detection → safe mode, crash reports, supervised daemons with backoff, watchdog with crash-loop detection, rotating JSONL log + live log stream |
| 12 | i18n (en / ja / ko / zh-TW / zh-CN) | `web/src/i18n/` (locales are type-checked against English) |
| 13 | Port usage list, auto-updated on forwarding changes | `server/src/modules/ports.ts` (`ss` / `/proc/net` + reservations, conflict detection), pushed over SSE |
| 14 | Dedicated NIC + independent subnet (e.g. /30) for VM/LXC | `server/src/modules/network.ts` (bridge per instance, IPAM pool, nftables NAT/isolation, dnsmasq DHCP) |
| 15 | Config as files, git auto-commit, S3 backups | `server/src/core/store.ts`, `modules/git.ts`, `modules/backup.ts` |

## Deploy (containers)

Requirements on the host: podman (with `podman.socket` enabled), libvirt/qemu for VMs, LXC, nftables, and btrfs-progs if the data directory is on btrfs.

The filesystem is detected per folder: compose / LXC / VM folders become btrfs subvolumes only when they are on btrfs; on ext4, xfs, zfs or anything else they are plain folders, and snapshots are simply not offered. `VAS_BTRFS=off` forces plain folders even on btrfs.

Start the podman API socket (`/run/podman/podman.sock`) — systemd:

```bash
sudo systemctl enable --now podman.socket
```

or Alpine / OpenRC:

```bash
rc-update add podman default && rc-service podman start
```

```bash
sudo mkdir -p /opt/vas && sudo cp -r . /opt/vas && cd /opt/vas/deploy
```

```bash
cp vas.env.example vas.env && sed -i "s|^VAS_AGENT_TOKEN=.*|VAS_AGENT_TOKEN=$(openssl rand -base64 32)|" vas.env
```

```bash
sudo podman-compose --env-file vas.env up -d --build
```

Then open `http://<host>:8080`, enter the setup token (from `VAS_SETUP_TOKEN` or `podman logs vas`) and register a passkey.

### Upgrading from "Hastur"

This service used to be called Hastur. An existing deployment keeps working:

- `HASTUR_*` variables are still read as a fallback for `VAS_*`; each one in use is logged once at startup with its new name.
- The default home `<data>/hastur` is moved to `<data>/vas` on the first start, if `<data>/vas` doesn't exist yet.
- Existing `hst-*` bridges, the `inet hastur` nftables table (removed on the next apply), certificates acme.sh renews into `hastur-certs`, `hastur-*` backups and `io.hastur.system` labels are all still recognised.

The containers, images and the CLI are renamed (`vas`, `vas-openresty`, `vas-acme`, CLI `vas`). Replace the old stack instead of starting the new one next to it, and move the data before the new containers mount it:

```bash
podman-compose -f /opt/hastur/deploy/compose.yaml --env-file /opt/hastur/deploy/hastur.env down
```

```bash
mv /mnt/data/hastur /mnt/data/vas && sed 's/^HASTUR_/VAS_/' /opt/hastur/deploy/hastur.env > deploy/vas.env
```

```bash
podman-compose --env-file vas.env up -d --build
```

Browser sessions start over (the cookie name changed); passkeys keep working.

### Mounts — read this

- **Same path inside and outside.** podman, libvirt and LXC run on the host, so every path the manager hands them must exist at the same absolute path on the host. The compose file mounts `${VAS_DATA_DIR}` at the same path, with `rshared` propagation so mounts and subvolumes created on either side are visible on both.
- **Subvolumes vs. mounts.** The manager checks the filesystem of the *parent* directory before creating each folder, so a non-btrfs disk mounted somewhere under the data dir gets plain folders while the btrfs parts still get subvolumes. It refuses to delete a folder that is a mount point or contains one, so a disk mounted into a compose project is never wiped. Nested subvolumes (e.g. created by podman) are deleted deepest-first.
- **Snapshots** go to `VAS_SNAPSHOT_DIR` (default `$VAS_DATA_DIR/.snapshots`), which must be on the same btrfs filesystem; this is verified with `findmnt` because subvolumes report distinct device numbers.
- VM folders get `chattr +C` (nodatacow) before the disk is created.
- Keep the deploy project **outside** `$VAS_DATA_DIR/container`, or the manager lists (and could stop) itself.

### LXC runs on the host

LXC containers are managed with the **host's** LXC. Run from inside the manager container, `lxc-start` would use the image's LXC build and the container's cgroup/AppArmor environment, and fail even with a config that starts fine from an SSH shell. Because the manager container has `pid: host` and `privileged: true`, it runs every `lxc-*` command (and the web terminal) through `nsenter --target 1` in the host's namespaces, the same as an SSH session. LXC containers therefore don't depend on the manager container and keep running when it restarts.

The host needs LXC with the `download` template and its tools. On Alpine:

```bash
apk add lxc lxc-download xz gnupg
```

`VAS_LXC_EXEC=auto` (default) picks host mode when running in such a container and local mode otherwise (e.g. with `deploy/vas.service`); `host` / `local` force either.

## Accessing VAS

### On a domain through OpenResty

Set `VAS_PUBLIC_DOMAIN=manager.example.com` and the manager generates a proxy route for itself. It has WebSockets on for terminals and noVNC, response buffering off for the live event stream, 1-hour timeouts, an optional IP allow-list (`VAS_PUBLIC_ALLOW`), and TLS per `VAS_PUBLIC_TLS` / `VAS_PUBLIC_CERT`. The route is shown read-only in the UI: it can't be edited or deleted there, user routes can't claim the same domain, and `vas-*` route IDs are reserved.

To get its certificate automatically, also set `VAS_ACME_EMAIL`, `VAS_PUBLIC_DNS_PROVIDER` (an acme.sh dnsapi such as `dns_cf`), and `VAS_PUBLIC_DNS_ENV` with the *names* of the variables that hold the credentials (optionally `VAS_PUBLIC_DNS_ALIAS` for DNS alias mode). The manager keeps a provider and a certificate called `vas-system` in line with the environment and issues the certificate at startup. After a failure it waits at least an hour before trying again, to stay clear of Let's Encrypt rate limits.

### Direct ports (fallback when OpenResty is broken)

`VAS_LISTEN` lists the addresses the UI listens on directly, e.g. `127.0.0.1:8080` (reach it with `ssh -L 8080:127.0.0.1:8080 host`) or `127.0.0.1:8080,192.168.1.10:8080` (loopback + LAN only). OpenResty and acme.sh call the manager on 127.0.0.1, so keep a loopback or `0.0.0.0` entry, or set `VAS_MANAGER_URL`.

### When you can't log in

Passkeys are bound to the hostname they were registered on. A passkey for `manager.example.com` doesn't work on `localhost:8080`, and browsers don't allow passkeys on bare IP addresses at all. Leave `VAS_RP_ID` unset, then on the host run:

```bash
vas auth login-link
```

It prints a link that logs you in once (valid 10 minutes) on the domain or on any direct port. From there you can register a passkey for that hostname under *Settings → Account*.

### VAS's own containers

The manager, its compose project, OpenResty and acme.sh are detected automatically, plus anything labelled `io.vas.system=true` or named in `VAS_SYSTEM_CONTAINERS`. They're shown with a "VAS" badge, logs only: the API refuses to start, stop, remove or edit them. Only the CLI can override that with `--force`, e.g. `vas container restart vas-openresty --force`.

## CLI

`vas` talks to the running manager over a root-only Unix socket (`VAS_ADMIN_SOCKET`, default `$VAS_STATE_DIR/admin.sock`). It needs no passkey, no web UI and no OpenResty. Install the host wrapper once:

```bash
install -m 755 deploy/vas /usr/local/bin/vas
```

- **Interactive:** `vas` opens a shell with tab completion of commands *and* resource names (containers, projects, LXC, VMs, routes, certificates) and history in `~/.vas_history`.
- **Scripting:** every command takes `--json` for machine-readable output and `--yes` to skip confirmations. Long operations stream their job output and fail the command if the job fails (`--detach` to just print the job id). Exit codes: `0` ok, `1` failed, `2` manager unreachable, `64` usage error.
- **When things are broken:** `vas status` still reports the last starts, the latest crash report and the last log lines when the manager is down. `vas lxc attach <name>` and `vas vm serial <name>` give a terminal without the browser (Ctrl+] detaches).

| | |
|---|---|
| `status`, `ports [--conflicts]`, `logs [-f] [--level warn]`, `jobs [id]` | overview, port map, live logs, follow a job |
| `ps`, `container <start\|stop\|restart\|rm\|logs\|inspect> <name>` | podman |
| `compose <ls\|show\|up\|down\|restart\|pull\|logs\|create\|edit\|rm> [name]` | `edit` opens `$EDITOR` and offers `up` afterwards |
| `lxc <ls\|info\|start\|stop\|attach\|console\|create\|images\|destroy>` | `create web1 --dist debian --release trixie` |
| `vm <ls\|info\|start\|shutdown\|force-off\|serial\|rm>` | |
| `route <ls\|show\|add\|import\|export\|rm\|preview\|reapply>`, `stream <ls\|add\|rm>` | `route export > routes.json` / `route import routes.json` |
| `cert <ls\|issue\|renew\|rm>`, `net <ls\|reconcile\|nft>` | |
| `waf <status\|events\|blocklist\|block\|unblock\|exclude>` | `waf events -f --action block`, `waf block 203.0.113.0/24` |
| `lua <ls\|add\|rm\|log\|server\|retry>` | `lua add lua-resty-http@0.17.1-0 --route shop` |
| `auth <login-link\|passkeys\|rm-passkey\|agent-token>`, `safe-mode <status\|exit>` | recovery |
| `git <status\|commit\|push>`, `backup <run\|ls>`, `settings <get\|set> <path> [value]` | `settings set openresty.httpsPort 8443` |
| `api <METHOD> <path> [json\|@file]` | any API endpoint, e.g. `vas api GET /system` |

## Configuration

All settings are environment variables; see [deploy/vas.env.example](deploy/vas.env.example). Runtime options (address pool, OpenResty ports, git, S3, watchdog) are edited in **Settings** and stored as files.

```
$VAS_CONFIG_DIR/            # default $VAS_DATA_DIR/vas/config — git repository
  settings.json
  openresty/http/<route>.json   openresty/stream/<id>.json
  acme/certs/<id>.json          acme/dns/<id>.json
  instances/{compose,lxc,vm}/<name>.json
  networks/<id>.json            auth/passkeys.json
  snapshots/                    # copies of compose.yaml, LXC config, VM XML written before each commit
  secrets/                      # DNS credentials, git/S3 keys, agent token — git-ignored by default
$VAS_STATE_DIR/             # sessions, boot history, cert status, dnsmasq leases (not committed)
$VAS_LOG_DIR/vas.log*    # rotating JSONL log, crashes/*.json
```

## Networking (dedicated NIC per instance)

Choosing *Dedicated NIC + own subnet* for an LXC container or VM:

1. allocates the next free block (default `/30`) from the pool `10.250.0.0/16`;
2. creates bridge `vas-xxxxxxxx` with the host side as gateway (`.1`), the instance gets `.2`;
3. writes one `inet vas` nftables table: masquerade for each subnet and, when isolated, drops routed traffic between `vas-*` bridges;
4. for VMs, starts a supervised dnsmasq that leases exactly that address to the VM's MAC (LXC gets the address statically).

Bridges and dnsmasq are restored at startup. If the host firewall (firewalld, netavark rules) sets a FORWARD drop policy, allow `vas-*` interfaces there too.

## Proxy targets that follow containers, LXC and VMs

Besides fixed `http://host:port` URLs, an upstream can name a workload. The route editor's picker lists every compose service, podman container, LXC container and VM, together with the container ports from `expose:` and `ports:` (published or not, from `compose.yaml` and from the running containers):

| Upstream | Resolves to |
|---|---|
| `compose://app/web:80` | the container IP of every running replica of service `web` in project `app` |
| `podman://my-db:5432` | the container's IP |
| `lxc://web1:22` | the dedicated-network address (or the address `lxc-ls` reports) |
| `vm://vm1:22` | the dedicated-network address (or the libvirt lease / guest agent address) |

Prefix `https+` (e.g. `https+compose://app/web:443`) to proxy over TLS. Stream forwards take the same references without the prefix.

References are resolved every time the bundle is built (on every agent poll), so a re-created container with a new IP, or a VM with a new lease, gets a new revision and OpenResty reloads by itself. Changes are logged as `upstream compose://app/web:80: 10.89.0.5:80 → 10.89.0.9:80`. A target that is stopped (including LXC containers and VMs that are shut down but keep their address) renders as a `down` placeholder, so the config stays valid.

**"Service not running" page.** Locations with workload upstreams catch nginx's own 502 (can't connect / no live upstream) with `error_page 502 = @vas_offline` and answer `503` with a small page in the visitor's language (en / ja / ko / zh-TW / zh-CN), `Retry-After: 15` and a self-refresh. Clients asking for JSON get `{"error":"upstream_offline",...}`. An app's own 502 responses pass through unchanged, and slow-app timeouts (504) are not relabeled. Internal target names are never shown. The page can be turned off per location, and replaced under *OpenResty proxy → Settings* with custom HTML using `{{host}}`, `{{title}}`, `{{message}}`, `{{lang}}`. The handler ships in the config bundle (`lua/vas_offline.lua`), so no image rebuild is needed.

Container IPs are reached directly from the host network, which works with rootful podman bridges (the default here). For rootless/slirp containers, only published ports are reachable, and the resolver falls back to them.

### Per-upstream options

Each upstream has an **Options** panel:

- **Server attributes** (per upstream, rendered on the nginx `server` line): weight, backup, max fails, fail timeout, max connections. Backups are only used when all other upstreams are down, and can't be combined with `ip_hash`.
- **Host header and TLS** (shared by all upstreams of a location, since nginx sets them per location; the editor keeps them in sync): a fixed Host header, certificate verification on/off, SNI on/off, TLS server name, and a trusted CA (PEM) for internal CAs. Verification without a custom CA uses the OpenResty image's system CA store.

The TLS server name defaults to the explicit name, else the Host override, else the URL's hostname, else the client's Host. Stream forwards take the server attributes only.

## Web application firewall

Every HTTP route can be filtered by a WAF that runs inside OpenResty. It's written in Lua and shipped in the config bundle (`lua/vas_waf.lua`, `waf/config.json`), so it needs no extra modules, no opm and no image rebuild.

- **Detection:** OWASP-CRS-style anomaly scoring. About 35 built-in rules cover SQL injection, XSS, path traversal and file inclusion, OS/PHP command injection, Log4Shell, Spring4Shell, SSRF to cloud metadata, Java deserialization, scanner user agents, and probes for `.git`, `.env`, backups and similar files. Values are URL-decoded twice before matching. Each match adds its severity; at the threshold (default 5, i.e. one critical rule) the request is acted on.
- **Paranoia:** level 1 has few false positives. Level 2 also inspects request bodies (form, JSON, XML and text up to the body limit; uploads and multipart are skipped) and adds stricter checks.
- **Modes per route:** `off`, `detect` (log only) or `block`; `inherit` uses the global default, which is **detect**, so turning the WAF on never breaks a site before you've looked at its events. The VAS UI route uses `VAS_PUBLIC_WAF` (default off, because the route editor legitimately submits Lua and shell snippets).
- **Tuning per route:** rule exclusions, path exclusions, and custom rules (match a target such as URI, args, body, a header or the client IP by contains/equals/regex, then block, log or allow). Custom rules run first; `allow` skips the WAF.
- **Global:** IP blocklist (an nginx `geo` map that always blocks, even in detect mode), disabling individual rules, threshold, body limit, and the response for blocked requests (403/406/429/451, or 444 to close the connection). Blocked visitors see a short page with a request ID; API clients get JSON.
- **Events:** recorded in OpenResty shared memory and shipped to VAS every 5 seconds by the agent process, kept in `state/waf-events.jsonl`. The **WAF** page shows them live, with the last 24 hours' totals, top rules, IPs and routes, and one-click *Block IP* / *Exclude rule on this route* for false positives. The same works from the CLI (`vas waf …`).
- **Safety:** an error inside the WAF engine is logged and the request is let through, never turned into a 500.

## Lua packages (LuaRocks)

Lua code in a route (server- or location-level `*_by_lua_block`, or `*_by_lua` in raw config) can `require` packages from LuaRocks:

- **Per route:** as soon as a route has Lua code, the route editor shows a **Lua packages** list. Add the package name (with suggestions such as `lua-resty-http`, `lua-resty-jwt`, `lua-resty-openidc`), optionally pin a version (`0.17.1-0`), and save.
- **Global:** *OpenResty proxy → Settings → Lua packages* holds packages for `init_worker` Lua and the global http config, an optional mirror (`--server`), and a table of every wanted package with the routes that use it, the installed version and the LuaRocks output of failed installs.
- **Installing:** the manager puts the union of all packages into the bundle (`luarocks/packages.json`). On a new revision the agent runs `luarocks --tree /data/luarocks install <name> [version]` for anything missing or changed and removes packages nothing needs any more. It does this **before** applying the config, so the new code finds its modules. A failed install is reported (UI banner, log, `vas lua ls`) but doesn't block the config. It is retried every 5 minutes and on *Retry* / `vas lua retry`. Packages bundled with OpenResty (`lua-resty-redis`, `lua-cjson`, …) are flagged, because a LuaRocks copy would shadow them.
- **Where:** `/data/luarocks` is on the OpenResty data volume, in `lua_package_path` / `lua_package_cpath`, and survives container re-creation. An idle agent never runs `luarocks`.
- **CLI:** `vas lua ls`, `vas lua add lua-resty-http@0.17.1-0 [--route shop]`, `vas lua rm <name> [--route id]`, `vas lua log <name>`, `vas lua server <url|--clear>`, `vas lua retry`.

> **Rebuild the OpenResty image once** (`podman compose -f deploy/compose.yaml build openresty`, then re-create the container). The new image adds the tree to `nginx.conf` and installs the tools LuaRocks needs to fetch and build packages (`git`, `unzip`, `curl`, `build-base`, `openssl-dev`). `luarocks` itself comes with the `alpine-fat` base. With an older image, packages show *luarocks not found*.

## OpenResty agent

The agent runs in the nginx *privileged agent* process (root, no requests served). Every `VAS_POLL_INTERVAL` seconds it calls the bundle endpoint with `?have=<revision>`; the manager answers `204` when nothing changed. A new revision is written to `/data/rev-<rev>/`, `/data/live` is swapped atomically, `openresty -t` validates it, and on failure the previous revision is restored and the error appears in the UI. The last good revision survives restarts even when the manager is down.

## ACME / DNS alias mode

1. *Certificates → DNS providers*: choose the acme.sh dnsapi (Cloudflare, Aliyun, DNSPod, Route53, …) and enter its variables. They are stored under `secrets/` and passed to `podman exec` through the environment, never on the command line.
2. *Certificates → New certificate*: domains, CA, key type, provider, and validation mode:
   - **DNS-01**: TXT records in the domain's own zone.
   - **DNS alias**: create `_acme-challenge.example.com CNAME _acme-challenge.alias-zone.net` once; acme.sh then only needs API access to `alias-zone.net` (`--challenge-alias`, or `--domain-alias`).
3. *Issue*. The certificate is installed to `<acme home>/vas-certs/<id>/`; routes with TLS `auto` pick it up by domain match. acme.sh's cron renews it and its reload hook calls `POST /api/agent/acme/renewed/<id>`; a 30-minute scan is the fallback.

## Crash management

- A `running.flag` marks a live process. If it still exists at the next start, the previous run counts as a crash. `VAS_CRASH_LOOP_THRESHOLD` unclean starts within `VAS_CRASH_LOOP_WINDOW_SEC` enable **safe mode**: no autostart, no watchdog, a banner in the UI, and *Exit safe mode* to resume.
- Uncaught exceptions write `logs/crashes/<ts>.json` with the stack trace and the last 200 log lines, then exit non-zero so the container or systemd restarts the manager.
- Supervised daemons (dnsmasq) restart with exponential backoff; 5 crashes in 2 minutes means a crash loop: a crash report is written and the next try waits 5 minutes.
- The watchdog restarts compose projects / LXC / VMs that have a restart policy and are meant to be running (backoff, gives up after 5 restarts in 10 minutes). Autostart runs in delay order.

## Development

```bash
npm install
```

```bash
VAS_DATA_DIR=./.dev-data VAS_AUTH_ENABLED=false npm run dev:server
```

```bash
npm run dev:web
```

Vite proxies `/api` (including WebSockets) to `127.0.0.1:8080`. On a machine without podman, LXC or libvirt, the pages show “not available on this host” instead of failing. `npm run typecheck` and `npm run build` cover both packages.

Passkeys need a secure context and a domain name for the RP ID: use `http://localhost` in development and HTTPS with a hostname in production (`VAS_RP_ID`, `VAS_ORIGIN`). A bare IP address does not work as a WebAuthn RP ID.
