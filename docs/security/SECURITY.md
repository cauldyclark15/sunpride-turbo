# Security controls

- Authentication: invitation-only Better Auth email and password sessions integrated with Convex JWT validation.
- Authorization: mutations derive the user from `ctx.auth`; role checks occur on the server. Client-provided user identifiers never grant authority.
- Bootstrap: `jcing.jc@gmail.com` is the only initial super admin. First-arrival order grants no authority; every other email must be authorized before account creation.
- Integration authentication: HMAC-SHA256 over `timestamp.body`, exact-body verification, and a five-minute replay window.
- Network boundary: the connector polls Convex and SAP. No cloud-initiated ingress to the SAP network is required.
- Secrets: Better Auth, connector, and SAP secrets are server/connector-only. `.env.local`, SQLite, PEM, and local connector data are ignored by Git.
- Data validation: Convex argument/return validators and versioned JSON Schemas define the API boundaries.
- Auditability: order creation/decisions and role changes append actor, action, entity, time, and optional decision context.

Before production, configure password reset and email verification delivery, rotate all bootstrap secrets, define the final role matrix, restrict connector egress destinations, set retention rules, and complete a penetration/privacy review.
