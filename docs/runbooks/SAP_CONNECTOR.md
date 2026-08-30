# SAP connector runbook

## Configure

1. Copy `apps/sap-connector/.env.example` to `apps/sap-connector/.env.local`.
2. Set `CONVEX_INTEGRATION_URL` to the deployment `.convex.site` URL.
3. Set `CONNECTOR_SIGNING_SECRET` to the same value configured in Convex.
4. Use `SAP_ADAPTER=mock` for acceptance testing. For SAP OData, switch to `odata` and provide the base URL and service account.

## Operate

```bash
bun run dev:sap
curl http://localhost:4100/health
curl http://localhost:4100/ready
curl http://localhost:4100/metrics
```

SQLite defaults to `apps/sap-connector/data/connector.sqlite`. Back it up before host replacement. A `degraded` heartbeat indicates the most recent cycle failed; inspect the local process logs and `/health.lastError`. Dead-letter records remain in SQLite for controlled investigation and replay. Do not delete or edit the database while the connector is running.

## Production acceptance

- Confirm SAP service-account least privilege and certificate trust.
- Validate field mappings against versioned contract fixtures.
- Exercise duplicates, timeouts, 401 responses, SAP rejection, and recovery after restart.
- Confirm the connector host can reach only the approved SAP endpoint and Convex site.
- Define monitoring ownership, poll interval, alert thresholds, cut-off times, and recovery SLA.
