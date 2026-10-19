# Auth

- `AuthClient` — native email sign-in to the Sunpride server (`POST {SUNPRIDE_API_ORIGIN}/api/auth/sign-in`, **no Origin header**). The response carries a durable session token, kept only in the Keychain, and a short-lived access token kept only in memory, refreshed through `POST /api/auth/refresh` 60 s before it expires and shared across concurrent callers. Sign-out wipes Keychain + memory first, then best-effort `POST /api/auth/sign-out`. The ephemeral HTTP session ignores Set-Cookie and has no cookie storage or URL cache.
- `ServerAPI` — `GET /api/me`, `POST /api/devices/{challenge,bind}` and the device-signed `/api/sync/pull` projections (team summary, suggested order); one retry with a forced token refresh after a 401.
- `SecureStore` — Keychain generic passwords, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synchronizable. `InMemoryStore` is for tests and the DEBUG stub backend only.
- `HTTPClient` — ephemeral, cookie-less, cache-less URLSession; any transport failure maps to `offline`.
- `Redaction` — `Redacted<T>` hides tokens from `print`/`dump`/debugger; `Redactor` scrubs server reasons before display.

Passwords are never stored or logged; the field is cleared on submit.
