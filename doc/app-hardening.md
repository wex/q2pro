# HTTP control-surface hardening

Branch: `fix/control-surface-hardening` (AUDIT-2 bug 5, items 7 + 12 + the
status-attribution half of item 16)

## Problems

- **Crash on malformed `Host`** — ``new URL(req.url, `http://${host}`)``
  threw `Invalid URL` inside the request listener (e.g. `Host: a b`) and
  killed the process.
- **No CSRF / DNS-rebinding protection** — every route accepted requests
  from any web origin: a page in the operator's browser could POST
  `/connect` (arbitrary host + password), `/record/start` (file writes
  under `assets/demos/`), or `/disconnect`. With DNS rebinding even the
  read routes (`/state`, `/stats`, `/events`) leaked.
- **`readJsonBody` ignored `Content-Type`** — form POSTs (`text/plain`,
  `application/x-www-form-urlencoded`) parse as JSON equally well in a
  browser context, so content-type enforcement is part of the CSRF story.
- **`/events` ignored `?session=`** — the snapshot always serialized the
  default session, and the UDP status handler wrote `latestStatus` into
  `defaultSession` unconditionally.
- **Status replies weakly attributed** — `isStatusReplySource` checked
  only the source port when the poll target was a hostname, so any local
  sender could spoof the serverinfo/player list shown in the UI.

## Changes (`src/app.ts`)

### Request guards — run before any routing

- **Constant URL base** — `new URL(req.url, 'http://ts-mvd.invalid')`;
  the base never depends on headers and is wrapped in try/catch → `400
  bad-request`. The host part was never used by routing anyway.
- **Host allow-list → `403 forbidden-host`** — accepted host names:
  `localhost`, `127.0.0.1`, `::1` (bracketed or bare), the `HTTP_HOST`
  bind address, and anything in the `HTTP_ALLOWED_HOSTS` env var
  (comma-separated). A missing Host (HTTP/1.0) is allowed — a browser
  always sends one, so the absence cannot be a rebinding vector.
- **Origin allow-list → `403 forbidden-origin`** — when an `Origin`
  header is present it must be `http(s)` and its hostname must satisfy
  the same allow-list. `Origin: null` (sandboxed frames, file://) is
  allowed; header-less requests (curl, supertest, the game's own tools)
  are unaffected.

### JSON content-type → `415 unsupported-media-type`

`/connect` and `/replay/control` require `Content-Type: application/json`
when a request carries a body. Bodyless POSTs stay allowed so
`curl -X POST /connect` keeps working. HTML forms cannot set this header
without triggering a CORS preflight, which the Origin check rejects.

### Session scoping

- `GET /events?session=<id>` resolves like every other route — the
  snapshot comes from the selected session, unknown ids get the standard
  `404 unknown-session`.
- The UDP status handler writes `latestStatus` into the session that
  initiated the poll (matched by host:port), falling back to `default`.

### Status reply attribution

`sendOOBStatus` now resolves the poll target's addresses via
`dns.lookup` (`resolveStatusTargetIps`, exported for tests). Once the
lookup lands, `isStatusReplySource` requires the reply address to be in
the resolved set for hostname targets — matching the long-standing IP
check for literal targets. Replies arriving before the first lookup
completes still fall back to the port check (brief window at stream
start; the query re-fires every 30 frames and re-checks each reply).

## Configuration

| Env var | Effect |
|---|---|
| `HTTP_HOST` | Bind address (default `127.0.0.1`); also allow-listed as a request Host |
| `HTTP_ALLOWED_HOSTS` | Comma-separated extra Host/Origin names, e.g. `HTTP_ALLOWED_HOSTS="mypc.local,192.168.1.10"` when serving on a LAN |

## Tests

- Malformed `Host` (`a b`) → 403, previously an uncaught `Invalid URL`.
- Foreign `Host` and cross-origin `Origin` → 403; localhost variants and
  same-origin → pass.
- `text/plain` body → 415; bodyless POST → accepted.
- `/events?session=nope` → 404.
- Hostname status target: port-only fallback while unresolved, resolved
  address set enforced after `resolveStatusTargetIps('localhost', …)`.
