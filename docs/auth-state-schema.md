# `auth_state` Schema

The `auth_state` block is exported as a top-level field in the MCP export and embedded in the Bundle export. It is the self-contained hidden-state payload an agent needs to replay an AgentScribe-recorded workflow without going back to the page.

This document describes every field, the heuristics behind each `auth_scheme` classification, how to read the decoded JWT, how `refresh_endpoint_hint` is derived, and how agents should consume the block.

---

## Top-level shape

```json
{
  "auth_state": {
    "cookies": [ ... ],
    "localStorage": { ... },
    "sessionStorage": { ... },
    "indexedDB": [ ... ],
    "classified_headers": [ ... ],
    "auth_scheme": "jwt-bearer",
    "auth_value_source": "header:Authorization",
    "expires_at": 1715954400000,
    "jwt_decoded": { ... },
    "refresh_policy": { ... }
  }
}
```

All fields are always present. Empty values default to `[]` / `{}` / `null`. Agents should always check for null before reading nested fields.

---

## Field reference

### `cookies` (array)

The last cookie snapshot captured during the session (most recent state wins). Each entry follows the Chrome `cookies.Cookie` shape.

**Type**: `Array<Cookie>`

**Example entry**:
```json
{
  "name": "_session_id",
  "value": "abc123...",
  "domain": ".example.com",
  "path": "/",
  "expirationDate": 1731556800,
  "httpOnly": true,
  "secure": true,
  "sameSite": "lax"
}
```

**How agents use it**: Inject directly into Playwright `browser.newContext({ storageState: { cookies } })`, or into a `fetch` `Cookie` header for HTTP replay. Note `httpOnly: true` cookies can only be set via `storageState` or HTTP `Set-Cookie` — they cannot be set from JavaScript.

---

### `localStorage` (object)

Key-value map of the active origin's localStorage at last capture.

**Type**: `Record<string, string>`

**Example**:
```json
{
  "auth_token": "eyJhbGciOi...",
  "user_id": "42",
  "feature_flags": "{\"betaUI\":true}"
}
```

**How agents use it**: Inject into Playwright via `storageState.origins[].localStorage`. For non-Playwright replay, set via `window.localStorage.setItem(k, v)` for each key before the first request.

---

### `sessionStorage` (object)

Same shape as `localStorage`. Note sessionStorage does NOT survive a browser restart — only useful for in-session replay.

**Type**: `Record<string, string>`

---

### `indexedDB` (array)

Metadata-only enumeration of IndexedDB stores at the recording origin. Values are NOT included — only structure.

**Type**: `Array<{ db: string, store: string, key_count: number }>`

**Example**:
```json
[
  { "db": "workbox-cache", "store": "responses", "key_count": 47 },
  { "db": "app-data", "store": "drafts", "key_count": 3 }
]
```

**How agents use it**: Signal — if `key_count > 0` on a store named like `auth` / `tokens` / `session`, the app may be keeping critical state in IDB and the agent should warn the user that this state is not replayable without a full IDB dump (which AgentScribe does not produce by default for privacy).

---

### `classified_headers` (array)

Every header AgentScribe saw on captured requests, deduped, with a classification tag.

**Type**: `Array<{ name: string, kind: string, metadata?: object }>`

**`kind` values**:
- `bearer-jwt` — `Authorization: Bearer <jwt>`
- `api-key` — `X-API-Key`, `X-Auth-Token`, `Api-Key`, or similar
- `csrf` — `X-CSRF-Token`, `X-XSRF-Token`, `_csrf` headers
- `hmac-signature` — `X-Signature`, `X-Hub-Signature`, or `Authorization` containing `signature=` / `hmac`
- `cookie` — `Cookie` header (value redacted in classified_headers; full cookies are in the `cookies` array)
- `other` — anything else

**How agents use it**: When constructing a replay request, look at every header from the original captured request and decide whether to copy literally, substitute from `auth_state`, or regenerate (HMAC headers must be regenerated per request — copying the literal value won't work).

---

### `auth_scheme` (string)

The single dominant authentication scheme for this session. Picked by highest-confidence candidate across all captured requests.

**Values + heuristic rationale**:

| Value | Detected when | Confidence |
|---|---|---|
| `jwt-bearer` | `Authorization: Bearer <token>` AND token has 3 base64url parts AND parses as JSON | 0.98 |
| `oauth-bearer` | `Authorization: Bearer <token>` but token is opaque (not a JWT) | 0.70 |
| `session-cookie` | No Authorization header, but a cookie with name matching `session` / `sid` / `auth` / `token` is sent on protected requests | 0.85 |
| `api-key` | A non-Authorization header matching `x-api-key`, `x-auth-token`, `api-key`, etc., carries a long opaque value | 0.90 |
| `hmac-signed` | `Authorization` contains `signature=` / `hmac`, OR a dedicated `X-Signature` / `X-Hub-Signature` header is present | 0.75 - 0.85 |
| `csrf` | `X-CSRF-Token` / `X-XSRF-Token` / `_csrf` header present (note: CSRF is typically additive to another scheme, not the sole scheme) | 0.60 |
| `custom` | Auth-like header present but matches none of the above patterns | 0.40 |
| `none` | No auth indicators detected (likely a public endpoint, or recording missed the login) | n/a |

When multiple schemes are detected on different requests (e.g., session-cookie + CSRF), the highest-confidence one wins for the `auth_scheme` field but BOTH are visible in `classified_headers`.

---

### `auth_value_source` (string | null)

Where the auth value lives, in `<storage>:<key>` format.

**Examples**:
- `header:Authorization`
- `cookie:_session_id`
- `cookie:rails_session`
- `header:X-API-Key`
- `localStorage:auth_token`
- `sessionStorage:access_token`

**How agents use it**: When refreshing or rotating credentials, this tells you which slot to write the new value into.

---

### `expires_at` (number | null)

Unix epoch in **milliseconds**, normalized. The exporter handles the JWT-seconds-vs-JS-milliseconds conversion automatically (any value below `1e12` is treated as seconds and multiplied).

**How agents use it**:
- Compare against `Date.now()` to check if the token is currently valid.
- Schedule a refresh `(expires_at - Date.now() - 60_000)` ms from now (60s safety margin).
- If `null`, fall back to 401-response-triggered refresh.

---

### `jwt_decoded` (object | null)

Present only when `auth_scheme === 'jwt-bearer'`. The full decoded JWT.

**Shape**:
```json
{
  "header": { "alg": "RS256", "kid": "key-1", "typ": "JWT" },
  "payload": {
    "sub": "user_42",
    "iss": "https://auth.example.com",
    "aud": "api.example.com",
    "exp": 1715954400,
    "iat": 1715950800,
    "scope": "read write"
  },
  "exp": 1715954400,
  "iss": "https://auth.example.com",
  "aud": "api.example.com",
  "raw": "eyJhbGciOi..."
}
```

**How to read it**:
- `header.alg` — the signing algorithm. RS256/ES256 means asymmetric (you cannot forge tokens). HS256 means symmetric (the server has a secret — you still cannot forge without it, but the token format is different).
- `header.kid` — the key ID. If the JWKS endpoint rotates, this tells you which public key was used.
- `payload.sub` — subject (typically user ID).
- `payload.iss` — issuer URL. Useful for finding the JWKS endpoint at `<iss>/.well-known/jwks.json`.
- `payload.aud` — audience. The API this token is scoped to.
- `payload.exp` — expiration in **seconds** (NOT ms — JWT spec). Multiply by 1000 for JS Date.
- `payload.iat` — issued-at in seconds.
- `payload.scope` — space-separated permission scopes if present.
- `raw` — the original token string. Pass this back verbatim when replaying.

**JWT signature is NOT verified** — AgentScribe decodes, it does not validate. The agent should trust the server's validation on replay.

---

### `refresh_policy` (object | null)

```json
{
  "refresh_endpoint": "/api/v2/auth/refresh",
  "method": "POST",
  "trigger": "expiry-time"
}
```

**`trigger` values**:
- `expiry-time` — refresh proactively before `expires_at`.
- `401-response` — refresh reactively on 401 / 403.

**How `refresh_endpoint` (formerly `refresh_endpoint_hint`) is derived**:

The bundle analyzer + correlation engine score every observed POST URL in the session against a refresh-URL regex. Higher scores win.

| Pattern in URL | Score |
|---|---|
| `/refresh` literal, `refresh_token`, `refreshtoken` | +0.50 |
| `/renew` literal | +0.40 |
| `/auth/token`, `/oauth/token`, `/token` | +0.35 |
| `/auth` (anywhere in path) | +0.15 |
| URL must be method POST AND match `refresh|renew|token|auth` at all | base |

The highest-scoring URL is exported. If no URL crosses the threshold, `refresh_policy` is `null` and the agent falls back to "re-record on expiry" or "prompt user to log in again."

**How agents use it**: When `expires_at` approaches, send `method` to `refresh_endpoint` with the current refresh token (typically pulled from `cookies` or `localStorage` per `auth_value_source` conventions). Replace the auth value in-place. If the refresh call returns 401, the session is dead — escalate to the user.

---

## How agents should use this block (recipe)

1. **On replay start**: Read `cookies`, `localStorage`, `sessionStorage` into the replay context (Playwright `storageState`, fetch headers, or direct browser injection).
2. **Per request**: Look up the original request's classified headers in `classified_headers`. Copy literally except:
   - HMAC headers: regenerate using the signing function in `bundleFindings`.
   - CSRF tokens: re-fetch from the documented source if rotated.
   - Bearer tokens: substitute from `auth_state.cookies` / `localStorage` per `auth_value_source`.
3. **Before each request**: Check `expires_at` against `Date.now()`. If within 60 seconds of expiry, fire `refresh_policy.refresh_endpoint` first.
4. **On 401 / 403 response**: Trigger `refresh_policy` (if defined) and retry once. If retry also 401s, the session is dead — surface to user.
5. **On replay failure with anti-bot challenge**: Check the session-level `challenge_layer` field (separate from `auth_state`). If non-null, AgentScribe is telling you bare replay won't work — the agent should use a stealth browser path or re-record under a different fingerprint.

---

## What's NOT in `auth_state`

- IndexedDB **values** (only metadata). If the app stores critical state in IDB, the agent will know but cannot replay it.
- Service Worker cache contents.
- Cross-origin worker state.
- Anything from iframes the recorder did not have access to.

For these gaps, see `docs/v1.0.13-known-gaps.md`.
