# Domain entity → PostgreSQL table mapping

One row per baseline domain entity (146). SQL migrations and `src/tables` are the current schema authority. Child tables
hold normalised arrays of line/membership facts (`<parent>_id`, `ordinal`).
The first Postgres table in each row is the main table; the test parses this file.

| Entity | Postgres table(s) | Migration | Notes |
|---|---|---|---|
| profiles | `profiles` | 0100_org | `user_id` → CORE `users`; `auth_subject` kept nullable (legacy actor token); synced (`deleted_at`, `change_seq`) |
| accessInvitations | `access_invitations` | 0100_org |  |
| products | `products`, `product_selling_uoms` | 0102_catalog | `sellingUomIds[]` → `product_selling_uoms`; synced (`deleted_at`, `change_seq`); `unit_price` float money → numeric(14,2) |
| customers | `customers` | 0102_catalog | synced (`deleted_at`, `change_seq`); `credit_limit` float money → numeric(14,2) |
| warehouses | `warehouses` | 0102_catalog |  |
| inventoryBalances | `inventory_balances` | 0107_inventory | synced (`deleted_at`, `change_seq`) |
| unitsOfMeasure | `units_of_measure` | 0102_catalog | synced (`deleted_at`, `change_seq`) |
| uomConversions | `uom_conversions` | 0102_catalog | synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges |
| productInventoryPolicies | `product_inventory_policies` | 0107_inventory | synced (`deleted_at`, `change_seq`) |
| replenishmentPolicies | `replenishment_policies` | 0107_inventory |  |
| inventoryLocations | `inventory_locations` | 0107_inventory | synced (`deleted_at`, `change_seq`) |
| inventoryLots | `inventory_lots` | 0107_inventory |  |
| inventoryLotBalances | `inventory_lot_balances` | 0107_inventory |  |
| inventoryCommands | `inventory_commands` | 0107_inventory | `result` jsonb |
| inventoryMovements | `inventory_movements` | 0107_inventory |  |
| inventoryMovementLines | `inventory_movement_lines` | 0107_inventory |  |
| inventoryAllocations | `inventory_allocations` | 0107_inventory |  |
| inventoryLedgerEntries | `inventory_ledger_entries` | 0107_inventory |  |
| inventoryReservations | `inventory_reservations` | 0107_inventory |  |
| inventoryReservationLines | `inventory_reservation_lines` | 0107_inventory |  |
| goodsReceipts | `goods_receipts` | 0107_inventory |  |
| goodsReceiptLines | `goods_receipt_lines` | 0107_inventory |  |
| stockTransfers | `stock_transfers` | 0107_inventory |  |
| stockTransferLines | `stock_transfer_lines` | 0107_inventory |  |
| stockCountSessions | `stock_count_sessions` | 0107_inventory |  |
| stockCountLines | `stock_count_lines` | 0107_inventory |  |
| inventoryAdjustments | `inventory_adjustments` | 0107_inventory |  |
| inventoryAdjustmentLines | `inventory_adjustment_lines` | 0107_inventory |  |
| billOfMaterials | `bill_of_materials` | 0107_inventory |  |
| billOfMaterialVersions | `bill_of_material_versions` | 0107_inventory |  |
| billOfMaterialComponents | `bill_of_material_components` | 0107_inventory |  |
| productionOrders | `production_orders` | 0107_inventory |  |
| productionMaterialIssues | `production_material_issues` | 0107_inventory |  |
| productionOutputReceipts | `production_output_receipts` | 0107_inventory |  |
| lotGenealogyLinks | `lot_genealogy_links` | 0107_inventory |  |
| truckRouteSessions | `truck_route_sessions` | 0107_inventory |  |
| truckInventoryCheckpoints | `truck_inventory_checkpoints` | 0107_inventory |  |
| truckInventoryCheckpointLines | `truck_inventory_checkpoint_lines` | 0107_inventory |  |
| vehicles | `vehicles` | 0110_van | synced (`deleted_at`, `change_seq`) |
| vanTrips | `van_trips` | 0110_van | synced (`deleted_at`, `change_seq`) |
| vanTripLoads | `van_trip_loads` | 0110_van | synced (`deleted_at`, `change_seq`) |
| vanTripLoadLines | `van_trip_load_lines` | 0110_van | synced (`deleted_at`, `change_seq`) |
| vanOperations | `van_operations` | 0110_van | synced (`deleted_at`, `change_seq`) |
| vanDamageRecords | `van_damage_records` | 0110_van | synced (`deleted_at`, `change_seq`) |
| vanDamagePhotos | `van_damage_photos` | 0110_van | synced (`deleted_at`, `change_seq`) |
| outletCreditTerms | `outlet_credit_terms` | 0110_van | synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges |
| sapInventorySnapshots | `sap_inventory_snapshots` | 0108_integration |  |
| negativeStockAllowances | `negative_stock_allowances` | 0107_inventory | synced (`deleted_at`, `change_seq`) |
| negativeStockFlags | `negative_stock_flags` | 0107_inventory |  |
| inventoryReconciliationRuns | `inventory_reconciliation_runs` | 0107_inventory |  |
| inventoryReconciliationDifferences | `inventory_reconciliation_differences` | 0107_inventory |  |
| salesAssignments | `sales_assignments` | 0102_catalog |  |
| visits | `visits` | 0109_pricing_orders |  |
| orders | `orders` | 0109_pricing_orders | synced (`deleted_at`, `change_seq`); `subtotal` float money → numeric(14,2); `total` float money → numeric(14,2) |
| orderLines | `order_lines` | 0109_pricing_orders | synced (`deleted_at`, `change_seq`); `unit_price` float money → numeric(14,2); `line_total` float money → numeric(14,2) |
| outsideCallOrders | `outside_call_orders`, `outside_call_order_lines` | 0109_pricing_orders | `lines[]` → `outside_call_order_lines`; synced (`deleted_at`, `change_seq`) |
| workflowInstances | `workflow_instances` | 0109_pricing_orders |  |
| approvals | `approvals` | 0109_pricing_orders |  |
| integrationEvents | `integration_events` | 0108_integration | `payload` jsonb |
| connectorHeartbeats | `connector_heartbeats` | 0108_integration |  |
| auditLogs | `audit_logs` | 0100_org |  |
| metrics | `metrics` | 0109_pricing_orders | `sales_today` float money → numeric(14,2) |
| dailyTerritoryMetrics | `daily_territory_metrics` | 0114_analytics |  |
| dailyCustomerMetrics | `daily_customer_metrics` | 0114_analytics |  |
| dailySkuMetrics | `daily_sku_metrics` | 0114_analytics |  |
| rollupContributions | `rollup_contributions`, `rollup_contribution_skus` | 0114_analytics | `skus[]` → `rollup_contribution_skus` |
| rollupRefreshes | `rollup_refreshes` | 0114_analytics |  |
| orgUnitTypes | `org_unit_types` | 0100_org |  |
| orgUnits | `org_units` | 0100_org | synced (`deleted_at`, `change_seq`) |
| orgUnitParentEdges | `org_unit_parent_edges` | 0100_org | synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges |
| territories | `territories` | 0101_territories | synced (`deleted_at`, `change_seq`) |
| territoryOwnerships | `territory_ownerships` | 0101_territories | synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges |
| territorySalespeople | `territory_salespeople` | 0101_territories | synced (`deleted_at`, `change_seq`) |
| routes | `routes` | 0101_territories | synced (`deleted_at`, `change_seq`) |
| routeTerritories | `route_territories` | 0101_territories | synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges |
| routeSalespeople | `route_salespeople` | 0101_territories | synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges |
| outlets | `outlets`, `outlet_contacts`, `outlet_photos` | 0103_outlets | `contacts[]` → `outlet_contacts`; `photoStorageIds[]` → `outlet_photos`; synced (`deleted_at`, `change_seq`) |
| outletCustomerLinks | `outlet_customer_links` | 0103_outlets | synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges |
| outletPins | `outlet_pins` | 0103_outlets | synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges |
| outletAssignments | `outlet_assignments` | 0103_outlets | synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges |
| outletEnrolments | `outlet_enrolments`, `outlet_enrolment_photos` | 0103_outlets | `photoStorageIds[]` → `outlet_enrolment_photos`; synced (`deleted_at`, `change_seq`) |
| outletEnrolmentEvents | `outlet_enrolment_events` | 0103_outlets |  |
| outletCodeSettings | `outlet_code_settings` | 0103_outlets |  |
| coveragePlans | `coverage_plans`, `coverage_plan_territories` | 0104_coverage | `territoryIds[]` → `coverage_plan_territories`; synced (`deleted_at`, `change_seq`) |
| coverageAssignments | `coverage_assignments` | 0104_coverage |  |
| coveragePlanOutlets | `coverage_plan_outlets` | 0104_coverage |  |
| coveragePlanSlots | `coverage_plan_slots` | 0104_coverage | synced (`deleted_at`, `change_seq`); `approved_snapshot` jsonb |
| positionRoutineTemplates | `position_routine_templates`, `position_routine_template_activities` | 0104_coverage | `activities[]` → `position_routine_template_activities`; exclusion: no overlapping effective ranges |
| plannedVisits | `planned_visits` | 0104_coverage | synced (`deleted_at`, `change_seq`); `approved_snapshot` jsonb |
| supervisorAwayPeriods | `supervisor_away_periods` | 0104_coverage | exclusion: no overlapping effective ranges |
| coverageAuditEvents | `coverage_audit_events` | 0104_coverage | `before` jsonb; `after` jsonb; `diff` jsonb |
| teams | `teams` | 0100_org |  |
| teamMemberships | `team_memberships` | 0100_org | exclusion: no overlapping effective ranges |
| employeeAssignments | `employee_assignments` | 0100_org | synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges |
| positions | `positions` | 0100_org |  |
| positionStandards | `position_standards` | 0100_org | synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges |
| workWithSessions | `work_with_sessions`, `work_with_session_observations` | 0112_supervision | `observations[]` → `work_with_session_observations` |
| perDiemValidations | `per_diem_validations` | 0112_supervision |  |
| talkSheets | `talk_sheets` | 0112_supervision |  |
| talkSheetItems | `talk_sheet_items` | 0112_supervision |  |
| trainerForms | `trainer_forms`, `trainer_form_evaluation_sessions` | 0112_supervision | `evaluationSessions[]` → `trainer_form_evaluation_sessions`; `program` jsonb; `sheet` jsonb; `evaluation` jsonb |
| fieldDayReports | `field_day_reports` | 0113_field_reports | `summary` jsonb |
| agentDailyMetrics | `agent_daily_metrics` | 0114_analytics | synced (`deleted_at`, `change_seq`); `sales_value` float money → numeric(14,2); `collections_value` float money → numeric(14,2) |
| agentMetricRefreshes | `agent_metric_refreshes` | 0114_analytics |  |
| salesTargets | `sales_targets` | 0114_analytics | synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges; `value` float money → numeric(14,2) |
| productBarcodes | `product_barcodes` | 0102_catalog | synced (`deleted_at`, `change_seq`) |
| importRuns | `import_runs`, `import_run_locations` | 0115_imports | `locationIds[]` → `import_run_locations` |
| registeredDevices | registered_devices | 0001_platform (lane CORE) | Platform table owned by CORE; not created here. |
| deviceChallenges | device_challenges | 0001_platform (lane CORE) | Platform table owned by CORE; not created here. |
| mobileRateLimits | rate_limits | 0001_platform (lane CORE) | Platform table owned by CORE; not created here. |
| visitExecutions | `visit_executions` | 0105_visits | synced (`deleted_at`, `change_seq`) |
| visitActivities | `visit_activities`, `visit_activity_evidence` | 0105_visits | `evidenceIds[]` → `visit_activity_evidence`; synced (`deleted_at`, `change_seq`); `activity` jsonb |
| visitActivityRules | `visit_activity_rules`, `visit_activity_rule_activities` | 0105_visits | `activities[]` → `visit_activity_rule_activities`; synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges |
| visitLocationEvidence | `visit_location_evidence` | 0105_visits | synced (`deleted_at`, `change_seq`) |
| fieldTasks | `field_tasks`, `field_task_evidence` | 0105_visits | `evidenceIds[]` → `field_task_evidence`; synced (`deleted_at`, `change_seq`) |
| fieldCollections | `field_collections` | 0105_visits | synced (`deleted_at`, `change_seq`) |
| evidenceUploadClaims | `evidence_upload_claims` | 0105_visits |  |
| fieldEvidenceFiles | `field_evidence_files` | 0105_visits | synced (`deleted_at`, `change_seq`) |
| executionEvents | `execution_events` | 0105_visits |  |
| processedMobileOperations | op_receipts | 0001_platform (lane CORE) | Platform table owned by CORE; not created here. |
| mobileChanges | change_log | 0001_platform (lane CORE) | Platform table owned by CORE; not created here. |
| mobileSyncState | (sync cursor state, CORE) | 0001_platform (lane CORE) | Platform table owned by CORE; not created here. |
| importRunErrors | `import_run_errors` | 0115_imports |  |
| issues | `issues` | 0117_issues | search index `search_issues` → `search_tsv` tsvector + GIN; filter fields use btree indexes |
| issueComments | `issue_comments` | 0117_issues |  |
| issueAttachments | `issue_attachments` | 0117_issues |  |
| issueActivity | `issue_activity` | 0117_issues | `changes` jsonb |
| issueCounters | `issue_counters` | 0117_issues |  |
| callSheetAccounts | `call_sheet_accounts`, `call_sheet_account_lines` | 0111_call_sheets | `lines[]` → `call_sheet_account_lines`; synced (`deleted_at`, `change_seq`) |
| callSheetAccountRevisions | `call_sheet_account_revisions`, `call_sheet_account_revision_products` | 0111_call_sheets | `productIds[]` → `call_sheet_account_revision_products`; synced (`deleted_at`, `change_seq`) |
| callSheetEntries | `call_sheet_entries` | 0111_call_sheets | synced (`deleted_at`, `change_seq`) |
| outletAssortments | `outlet_assortments`, `outlet_assortment_products` | 0106_merchandising | `productIds[]` → `outlet_assortment_products`; synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges |
| merchandisingAudits | `merchandising_audits`, `merchandising_audit_missing_products`, `merchandising_audit_evidence` | 0106_merchandising | `missingRequiredProductIds[]` → `merchandising_audit_missing_products`; `evidenceIds[]` → `merchandising_audit_evidence`; synced (`deleted_at`, `change_seq`) |
| merchandisingAvailability | `merchandising_availability`, `merchandising_availability_evidence` | 0106_merchandising | `evidenceIds[]` → `merchandising_availability_evidence`; synced (`deleted_at`, `change_seq`) |
| merchandisingComplianceChecks | `merchandising_compliance_checks`, `merchandising_compliance_check_evidence` | 0106_merchandising | `evidenceIds[]` → `merchandising_compliance_check_evidence`; synced (`deleted_at`, `change_seq`) |
| competitorObservations | `competitor_observations`, `competitor_observation_evidence` | 0106_merchandising | `evidenceIds[]` → `competitor_observation_evidence`; synced (`deleted_at`, `change_seq`) |
| suggestedOrderPromotions | `suggested_order_promotions` | 0114_analytics | synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges |
| priceLists | `price_lists` | 0109_pricing_orders | synced (`deleted_at`, `change_seq`) |
| priceListLines | `price_list_lines` | 0109_pricing_orders | synced (`deleted_at`, `change_seq`); exclusion: no overlapping effective ranges |
| fieldOrderPricings | `field_order_pricings`, `field_order_pricing_lines` | 0109_pricing_orders | `lines[]` → `field_order_pricing_lines`; synced (`deleted_at`, `change_seq`) |
| sampleDataChanges | `sample_data_changes` | 0118_beta |  |
| promotions | `promotions` | 0109_pricing_orders | synced (`deleted_at`, `change_seq`); `rule` jsonb |
| sampleDataRows | `sample_data_rows` | 0118_beta |  |
| adminPackRecords | `admin_pack_records` | 0114_analytics | 4-variant union: shared columns + `kind` + per-kind `details` jsonb |
| locationPings | `location_pings` | 0116_location | synced (`deleted_at`, `change_seq`) |
| liveLocations | `live_locations` | 0116_location | synced (`deleted_at`, `change_seq`) |

Better Auth component tables are not mapped: CORE's `users` and `sessions` replace them.
File references use platform `files(id)` foreign keys (CORE).
