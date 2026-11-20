# Usage routes ride the platform admission policy

## Problem

`dsh-usage` served three host routes — `/api/dsh-usage/overview`, `/day` and `/refresh` — carrying personal account data: provider balances, plan-quota windows, per-model token counts and cost estimates. It registered them as `kind: 'exact'` web-server routes and guarded them with a fence of its own (`src/host/access.ts`): a loopback socket plus a loopback `Host` header plus a not-cross-site marker, OR a live paired-device cookie read from the third-party `remoteWebUiPairing` service.

Two facts made that fence the wrong owner for the decision.

First, the platform's authenticated carrier is the `/api` PREFIX route owned by `dsh-client-connection`, whose handler calls `connection.admit()` — the Host/Origin fence plus a signed browser-session cookie. The web server matches the EXACT table before the prefix table, so the plugin's exact routes SHADOWED the platform's `/api` route: `admit()` never ran for them. The plugin's own fence was the only thing in front of account data.

Second, the route objects carried `auth: 'anonymous'` — a field the plugin declared for itself (`type AuthAwareWebRoute = WebRoute & { readonly auth?: ... }`) that the platform does not read anywhere. It looked like a platform contract and enforced nothing; setting it to `'required'` or `'deny'` would have changed nothing either.

The paired-device path was the sharper edge: the `dsh_pair` cookie is a 128-bit device id used directly as the session credential, stored in plaintext for a year, and accepted from ANY network path. Anyone holding it could read the usage data over the LAN or through a tunnel, and could `POST /refresh` to make the host use the API key against the vendor on demand. That gate belongs to a package its own author documents as a retired capability.

## Decision

The usage routes answer under the platform's admission policy, and the plugin owns no access-control logic at all. Each handler's first act is `ctx.connection.requestRejection(req)` — the documented way to apply Connection's Host/Origin checks and browser authentication to a route that is not under the `/api` prefix — and a refusal answers `401` (no usable credential) or `403` (fence refused) in the plugin's own JSON shape.

The plugin therefore injects the `connection` service (`inject = ['webServer', 'connection']`), and `src/host/access.ts`, the generated `src/host/pair-access.ts` and the generated `src/host/loopback.ts` are gone. The package no longer mentions `remoteWebUiPairing` and depends on no pairing service. The `auth: 'anonymous'` annotation is gone with them, because a marker the platform ignores is worse than no marker.

The fence is now:

- a request with no usable credential gets `401` — including one presenting only a `dsh_pair` cookie, and including a plain `curl` to the loopback port, which the old fence passed automatically;
- a request the Host/Origin fence refuses gets `403` (foreign `Host`, `Sec-Fetch-Site: cross-site`);
- a request with a live DSH browser session gets the data, from the desktop, from a LAN proxy, and through a tunnel alike.

The client request paths, the JSON response contract, the `cache-control: no-store` header, the date validation and the `POST`-only refresh gate are unchanged, so the browser half needed no change at all.

## Alternatives considered

Moving the three routes into the authenticated `/api` mux via `ctx.connection.fetch.register()` was rejected for this deployment: an exact Fetch route is dispatched BEFORE the Gateway interceptor and is additionally restricted to `peer.principal.kind === 'owner'`, which answers `403` to a paired mobile device that has redeemed a browser credential. The platform's `requestRejection` gives the same authentication guarantee — the same `admit()` decision — while admitting every authenticated session. The Fetch-route form remains the right choice for a route that must stay owner-only, and it is recorded here so that decision is not re-litigated from scratch.

Keeping the plugin's own fence but hardening it (signed edge header, `trustedHosts` validation, same-origin requirement) was rejected: it would keep a second, weaker trust policy alive that could only ever narrow the platform's, and it would keep the plugin coupled to one proxy's shape.

Leaving the routes as they were and documenting the exposure was rejected: the plugin's fence was the only gate, and a gate that a third-party, retired, single-maintainer package owns is not a gate an operator can reason about.

Making the plugin depend on the platform's `/api` prefix route by registering under a different path prefix was rejected for the same reason as the Fetch-route form: it changes who may read the data.

## Consequences

A request to the usage API now needs a DSH session. Scripts that curled `/api/dsh-usage/overview` on the loopback port and expected `200` now get `401`; they must present a session cookie. The browser and any proxy that exchanges the launch token are unaffected.

The plugin no longer needs `dsh-remote-web-ui` for anything. That package can stay in a profile for the mobile pairing QR flow, the `/remote` channel, LAN forwarding and the relay identity — but it contributes nothing to `/api` protection in the 0.2.2-rc.3 cohort either way: its `api/gate` listener has no emitter there, as its own source states.

### Remote devices still work, through a transport rather than a fence

Removing the plugin's fence does **not** remove remote access. It moves the question from "which cookie does the plugin trust" to "which transport carries the browser", and the two independent layers answer differently:

- **Trust** is the platform's, everywhere. A remote browser that holds a real DSH browser session satisfies `requestRejection` exactly as a local one does.
- **Transport** is the deployment's. A browser reaching the host through a tunnel needs something in front of the host that mints or forwards that DSH session cookie. In the deployment this package was extracted from, that is the local edge proxy: it listens on the LAN interface, exchanges dsh's launch token for a session cookie server-side, and forwards to `127.0.0.1`. A paired-device channel (the `dsh-remote-web-ui` / `remote-bridge` `/remote` proxy) is a second, alternative transport that does the same thing for a QR-paired device.

Measured on that deployment: `GET /api/dsh-usage/overview` through the edge proxy with the public `Host` and Cloudflare forwarding headers answers `200` with the full document, no plugin patch involved; without a credential it answers `401`; and a `dsh_pair` cookie presented directly — not through any proxy — also answers `401`. The paired-device cookie is never a credential for the usage data, whichever transport is in use.

The shared fence modules stayed behind in the upstream monorepo for their other consumers; this package is simply no longer one of the manifest targets.

## Testing

`tests/routes.spec.ts` drives the admission decision directly: a refusing `connection` service must produce `401`/`403` on all three endpoints, and the usage service must never be consulted for a refused request. A dedicated case asserts that a context exposing a pairing service whose `isPairedDevice` returns true still answers `401` when the platform refuses — the regression test for the paired-cookie hole. `tests/apply.spec.ts` pins `connection` into the plugin's inject list and keeps the route-registration and row-reload assertions intact. The package suite is 208 tests; `pnpm typecheck` and `pnpm build` pass.
