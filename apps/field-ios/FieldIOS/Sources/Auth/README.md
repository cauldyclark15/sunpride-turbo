# Auth

- `AuthClient` — Better Auth email sign-in (`POST {CONVEX_SITE_URL}/api/auth/sign-in/email`, **no Origin header**), session token read only from the `set-auth-token` header of a 2xx response and kept only in the Keychain; Convex JWT from `GET /api/auth/convex/token` kept only in memory, refreshed 60 s before `exp`, shared across concurrent callers; sign-out wipes Keychain + memory first, then best-effort `POST /api/auth/sign-out`.
- `ConvexFunctions` — `POST {CONVEX_URL}/api/query|mutation` with `{path,args,format:"json"}`; decodes `{status:"success",value}` / `{status:"error",errorMessage,errorData?}` (HTTP 200 or 560); one retry with a forced JWT refresh after a 401.
- `SecureStore` — Keychain generic passwords, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synchronizable. `InMemoryStore` is for tests and the DEBUG stub backend only.
- `HTTPClient` — ephemeral, cookie-less, cache-less URLSession; any transport failure maps to `offline`.
- `Redaction` — `Redacted<T>` hides tokens from `print`/`dump`/debugger; `Redactor` scrubs server reasons before display.

Passwords are never stored or logged; the field is cleared on submit.
