# ADR-008: Governed pricing and SAP replicas

Status: accepted, updated to Phase 1 and the v2 SAP mediation layer.

SAP owns pricing and credit. The API keeps versioned, effective-dated replicas with source provenance; current development uses explicitly marked sample rows and `apps/sap-mock`. Missing client access is not permission to treat invented prices as real SAP data.

Clients never authorize price, discount or credit by submitting their own amount. Offline prices are bounded previews; server acceptance resolves the governed price/UOM at the relevant service instant and performs the required credit policy through the SAP boundary. Unknown price/exposure is not zero and cannot certify a credit limit.

Retain captured intent and frozen sale-time facts. A master refresh cannot silently alter an existing receipt or replay. Conflicting/ambiguous price intervals enter review. Only the configured SAP authority may provide accounting document outcomes.

Implementation: `apps/api/src/domains/orders`, `apps/api/src/domains/integration`, and [SAP spec](../spec/sap.md). Real SAP authentication/services and production financial acceptance still require separate verification.
