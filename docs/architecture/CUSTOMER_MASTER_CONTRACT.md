# Customer master contract (SP-0170)

Backend contract for the web and Android lanes. Source of truth for the fields: Sunpride's
"Customer Information template" (Loren Muñoz, MIS/IT, 2026-11-10) — committed as
`docs/requirements/client-customer-information-template-2026-11-10.xlsx` and extracted to
`packages/db/reference/sunpride-customer-master-2026-11-10.json`. Model and operations:
`docs/runbooks/CUSTOMER_MASTER.md`.

**Customer = store.** One record per store. The record's id is the store (`outlets.id`) and its
`code` is the **Customer Code**. Users never see a second "accounting customer"; the API keeps it
1:1 (same code) behind the scenes.

Shared rules: `@sunpride/customer-master` (pure JS; import it on web for live form checks and in
upload previews). It exports `FIELDS`, `SECTIONS`, `validateCustomer`, `formatAddress`,
`optionLabel`, `normalizeTin`, `normalizePhMobile`, `shipToFromCustomer`, `ERROR_CODES`.

## 1. Field keys and the client's labels (sheet order)

Labels are the client's exact wording; use them in forms, upload headers and messages.
Dropdowns show `optionLabel(row)` = "Description (Code)", e.g. "General Trade (30)",
"Due in 7 days (0003)" (Type of Business has no codes: the description is shown alone).

| #   | Section                      | Label                      | API key                   | Required for `complete`                | Kind / list                 |
| --- | ---------------------------- | -------------------------- | ------------------------- | -------------------------------------- | --------------------------- |
| 1   | Customer General Information | Registered Name            | `registeredName`          | yes                                    | text                        |
| 2   | Customer General Information | Trade Name                 | `tradeName`               | no                                     | text                        |
| 3   | Customer General Information | Customer Name              | `customerName`            | yes                                    | text                        |
| 4   | Customer General Information | Customer Address           | `customerAddress`         | yes                                    | text                        |
| 5   | Customer General Information | Email Address              | `email`                   | no                                     | email                       |
| 6   | Customer General Information | Mobile No.                 | `mobileNo`                | yes                                    | mobile                      |
| 7   | Customer General Information | Tel. No.                   | `telNo`                   | no                                     | text                        |
| 8   | Customer General Information | TIN number                 | `tin`                     | no                                     | tin                         |
| 9   | Customer General Information | Tax Classification         | `taxClassificationCode`   | yes                                    | list `tax_classification`   |
| 10  | Customer Location            | Country                    | `countryCode`             | yes                                    | list `country`              |
| 11  | Customer Location            | Region                     | `regionCode`              | yes                                    | geo                         |
| 12  | Customer Location            | Province                   | `provinceCode`            | yes                                    | geo                         |
| 13  | Customer Location            | Municipality               | `municipalityCode`        | yes                                    | geo                         |
| 14  | Customer Location            | Barangay                   | `barangayCode`            | yes                                    | geo                         |
| 15  | Customer Location            | House No.                  | `houseNo`                 | no                                     | text                        |
| 16  | Customer Location            | Street 1                   | `street1`                 | no                                     | text                        |
| 17  | Customer Location            | Street 2                   | `street2`                 | no                                     | text                        |
| 18  | Customer Location            | Floor                      | `floor`                   | no                                     | text                        |
| 19  | Customer Location            | Room No. / Stall No.       | `roomStallNo`             | no                                     | text                        |
| 20  | Customer Location            | Postal Code                | `postalCode`              | yes                                    | geo                         |
| 21  | Customer Location            | Geographical Coordinates   | `coordinates`             | yes                                    | coordinates                 |
| 22  | Customer Assignment          | Sales Organization         | `salesOrgCode`            | yes                                    | list `sales_organization`   |
| 23  | Customer Assignment          | Sales Office               | `salesOfficeCode`         | yes                                    | list `sales_office`         |
| 24  | Customer Assignment          | Distribution Channel       | `distributionChannelCode` | yes                                    | list `distribution_channel` |
| 25  | Customer Assignment          | Customer Grp 1             | `customerGroup1Code`      | yes, when the channel has Grp 1 values | list `customer_group_1`     |
| 26  | Customer Assignment          | Customer Grp 2             | `customerGroup2Code`      | yes, when the Grp 1 has Grp 2 values   | list `customer_group_2`     |
| 27  | Customer Assignment          | Customer Group             | `customerGroupCode`       | yes                                    | list `customer_group`       |
| 28  | Customer Assignment          | Type of Business           | `typeOfBusiness`          | yes                                    | list `type_of_business`     |
| 29  | Customer Assignment          | Sales Partner              | `salesPartnerCode`        | no                                     | list `sales_partner`        |
| 30  | Payment Arrangement          | Terms of payment           | `paymentTermsCode`        | yes                                    | list `payment_terms`        |
| 31  | Payment Arrangement          | Credit Limit               | `creditLimit`             | no                                     | money                       |
| 32  | Payment Arrangement          | Customer Pricing Procedure | `pricingProcedureCode`    | yes                                    | list `pricing_procedure`    |
| 33  | Delivery Arrangement         | Delivering Plant           | `deliveringPlantCode`     | yes                                    | list `delivering_plant`     |
| 34  | Delivery Arrangement         | Ship-to Party              | `shipTos[].shipToParty`   | yes                                    | text                        |
| 35  | Delivery Arrangement         | Ship-to Address            | `shipTos[].shipToAddress` | yes                                    | text                        |
| 36  | Delivery Arrangement         | Contact Person             | `shipTos[].contactPerson` | yes                                    | text                        |
| 37  | Delivery Arrangement         | Mobile No.                 | `shipTos[].mobileNo`      | yes                                    | mobile                      |
| 38  | Delivery Arrangement         | Email Address              | `shipTos[].email`         | no                                     | email                       |
| 39  | ADP Specific                 | Distributor Code           | `distributorCode`         | yes, channel 40 only                   | text                        |
| 40  | ADP Specific                 | Distributor Name           | `distributorName`         | yes, channel 40 only                   | text                        |
| 41  | ADP Specific                 | Distributor Customer Code  | `distributorCustomerCode` | yes, channel 40 only                   | text                        |
| 42  | ADP Specific                 | Distribution Mode          | `distributionMode`        | yes, channel 40 only                   | text                        |
| 43  | ADP Specific                 | Sub-Distributor Code       | `subDistributorCode`      | yes, channel 40 only                   | text                        |
| 44  | ADP Specific                 | Sub-Distributor Name       | `subDistributorName`      | yes, channel 40 only                   | text                        |
| 45  | ADP Specific                 | Distributor Salesman       | `distributorSalesman`     | yes, channel 40 only                   | text                        |
| 46  | ADP Specific                 | Distributor Salesman Code  | `distributorSalesmanCode` | yes, channel 40 only                   | text                        |
| 47  | ADP Specific                 | Truck Serving              | `truckServing`            | yes, channel 40 only                   | text                        |
| 48  | ADP Specific                 | Truck Code                 | `truckCode`               | yes, channel 40 only                   | text                        |
| 49  | ADP Specific                 | Distributor Hub            | `distributorHub`          | yes, channel 40 only                   | text                        |
| 50  | ADP Specific                 | Cluster #                  | `clusterNo`               | yes, channel 40 only                   | text                        |
| 51  | ADP Specific                 | Cluster Name               | `clusterName`             | yes, channel 40 only                   | text                        |

System key before the sheet's fields: **Customer Code** = `code`. New customers get a
system-generated code (`SP000123`, the existing store-code allocator) unless one is sent; the
office may change it (`PUT` with top-level `code`) until the accounting customer has a SAP
`external_id`, after which `422 code_locked`.

Notes:

- `customerAddress` (Customer Address) is generated from the location parts with
  `formatAddress` — `Room/Stall, Floor, House No. Street 1, Street 2, Barangay, Municipality,
Province Postal Code` — unless the user types one (then `addressCustom: true`). Sending
  `customerAddress: ""` returns it to the generated line.
- `coordinates` (Geographical Coordinates) is sent as `latitude` + `longitude`. A new or moved
  position becomes a **pending pin** (the existing two-person pin verification). Read back:
  `latitude`, `longitude`, `pinStatus` (`pending` | `verified` | null).
- Ship-to entries are `shipTos: [{ shipToParty, shipToAddress, contactPerson, mobileNo, email,
sameAsCustomer }]`, one or more. `sameAsCustomer: true` copies Customer Name, Customer Address,
  Mobile No. and Email from the customer; Contact Person must still be sent (it is not a customer
  field in the sheet; the field app passes the owner's name). On create with no `shipTos`, one
  "same as customer" entry is made (`contactPerson` from top-level `contactPerson` if sent).
  Sending `shipTos` replaces the whole list.
- Mobile numbers are stored as `09XXXXXXXXX` (`+639XXXXXXXXX` accepted). TIN is stored dashed
  (`###-###-###` or `###-###-###-###`; digits only accepted). Email is stored lower-case.
- `typeOfBusiness` codes are the descriptions themselves ("Sole Proprietor", "Corporation", …).

## 2. Levels and conditional rules

- `draft` (any save): only Customer Name is required; whatever is filled must be valid
  (formats, list membership, dependencies). Field captures may be drafts.
- `complete` (approval/activation and uploads): every field marked required in the sheet, with:
  - **Customer Grp 1** required only when the Distribution Channel has Grp 1 values (not 50 Services).
  - **Customer Grp 2** required only when the chosen Grp 1 has Grp 2 values (not Food Service 20,
    Corporate 80, Services 50); sending one where none apply is `not_applicable`.
  - **ADP Specific** (13 fields) required only for Distribution Channel **40** Distributive Trade.
  - At least one complete ship-to.
- Dependent lists (rule 8): Sales Office, Distribution Channel and Delivering Plant must belong
  to the Sales Organization (ARI 2000 has only channels 20, 70, 80); Grp 1 must be under
  (Sales Org, Channel); Grp 2 under (Sales Org, Channel, Grp 1).
- Geography (rule 9): Province in Region, Municipality in Province, Barangay in Municipality,
  Postal Code one of the municipality's codes. Country is `PH` only.
- Every saved record carries `completeness: "draft" | "complete"` (re-evaluated on each save).

## 3. Routes

All under the existing session/bearer auth. JSON bodies. Write routes accept an optional
`Idempotency-Key` header (same key + same body replays the first result; different body →
`409 idempotency_conflict`). Every write returns the full customer (shape in §4).

| Method + path                                          | Capability                              | Purpose                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/customers`                                | `outlet.read` (scoped)                  | List. Query: `q` (name/code/registered name), `status` (`prospect`/`active`/`inactive`), `completeness`, `salesOrgCode`, `distributionChannelCode`, `customerGroup1Code`, `customerGroupCode`, `limit` (≤200, default 50), `cursor` (from `nextCursor`). Returns `{ rows, nextCursor }`. |
| `GET /api/v1/customers/:id`                            | `outlet.read` (scoped)                  | Full customer (§4).                                                                                                                                                                                                                                                                      |
| `POST /api/v1/customers`                               | `outlet.manage` in `custodianOrgUnitId` | Create. Body `{ custodianOrgUnitId, customer: {…fields}, code?, contactPerson?, reason? }`. Always created as `prospect`.                                                                                                                                                                |
| `PUT /api/v1/customers/:id`                            | `outlet.manage` (scoped)                | Update. Body `{ customer: {…changed fields}, code?, reason? }`. Unsent keys keep their value; `null`/`""` clears.                                                                                                                                                                        |
| `POST /api/v1/customers/:id/approve`                   | `outlet.enrol.approve` (scoped)         | Requires `complete` (else `422 validation_failed` with every missing field). Decides a pending field enrolment through the existing writer (two-person rule; allocates the final code), sets `active`.                                                                                   |
| `POST /api/v1/customers/:id/deactivate`                | `outlet.manage` (scoped)                | Store `inactive` (assignments closed, as today) and the accounting customer `active=false`. Body `{ reason? }`.                                                                                                                                                                          |
| `POST /api/v1/customers/validate`                      | `outlet.read`                           | Dry run for forms/uploads: `{ customer, level: "draft"\|"complete" }` → `{ ok, level, errors }` (same derivations as a save).                                                                                                                                                            |
| `GET /api/v1/customers/fields`                         | `outlet.read`                           | `{ fields: [{ key, label, section, required, kind, list, shipTo, adp, max }] }` in sheet order.                                                                                                                                                                                          |
| `GET /api/v1/customers/reference`                      | `outlet.read`                           | All lists: `{ lists: { <list>: [option…] } }`.                                                                                                                                                                                                                                           |
| `GET /api/v1/customers/reference/:list`                | `outlet.read`                           | One list, filtered: `salesOrgCode` (required for `sales_office`, `distribution_channel`, `delivering_plant`, `customer_group_1`, `customer_group_2`), `distributionChannelCode` (required for Grp 1/2), `customerGroup1Code` (required for Grp 2). → `{ list, options }`.                |
| `GET /api/v1/geography/countries`                      | `outlet.read`                           | `[{ code:"PH", name:"Philippines" }]`                                                                                                                                                                                                                                                    |
| `GET /api/v1/geography/regions`                        | `outlet.read`                           | 18 regions.                                                                                                                                                                                                                                                                              |
| `GET /api/v1/geography/provinces?regionCode=`          | `outlet.read`                           | Provinces of a region (NCR districts appear as provinces).                                                                                                                                                                                                                               |
| `GET /api/v1/geography/municipalities?provinceCode=`   | `outlet.read`                           | Municipalities/cities (`kind`, `cityClass`).                                                                                                                                                                                                                                             |
| `GET /api/v1/geography/barangays?municipalityCode=`    | `outlet.read`                           | Barangays.                                                                                                                                                                                                                                                                               |
| `GET /api/v1/geography/postal-codes?municipalityCode=` | `outlet.read`                           | Postal codes of the municipality (`code`, `name`, `source`).                                                                                                                                                                                                                             |
| `GET /api/v1/geography/release`                        | `outlet.read`                           | Loaded PSGC release and counts.                                                                                                                                                                                                                                                          |

Geography responses: `{ options: [{ code, name, label, …parent codes }] }` (PSGC codes are 10
digits, text). Reference option: `{ list, salesOrgCode, channelCode, group1Code, code, name,
label, active }`.

Lists (`:list`, `-` or `_`): `tax_classification`, `country`, `sales_organization`,
`sales_office`, `distribution_channel`, `customer_group_1`, `customer_group_2`,
`customer_group`, `type_of_business`, `sales_partner`, `payment_terms`, `pricing_procedure`,
`delivering_plant`. `sales_partner`: Sunpride's "List of Agents" is still empty, so it offers our
active field/van sales employees (`code` = employee code) until they send it.

## 4. Customer response

```json
{
  "id": "uuid (store id)",
  "code": "SP000123",
  "status": "prospect|active|inactive",
  "completeness": "draft|complete",
  "enrolmentStatus": "provisional|approved|rejected|null",
  "customerName": "Aling Rosa Store",
  "customerAddress": "12 Gorordo Ave, Apas, City of Cebu, Cebu 6000",
  "addressCustom": false,
  "registeredName": "…",
  "tradeName": null,
  "email": "rosa@example.ph",
  "mobileNo": "09171234567",
  "telNo": null,
  "tin": "123-456-789",
  "taxClassificationCode": "1",
  "taxClassificationName": "Liable for Taxes",
  "countryCode": "PH",
  "countryName": "Philippines",
  "regionCode": "0700000000",
  "regionName": "Region VII (Central Visayas)",
  "provinceCode": "0702200000",
  "provinceName": "Cebu",
  "municipalityCode": "0730600000",
  "municipalityName": "City of Cebu",
  "barangayCode": "0730600003",
  "barangayName": "Apas",
  "houseNo": "12",
  "street1": "Gorordo Ave",
  "street2": null,
  "floor": null,
  "roomStallNo": null,
  "postalCode": "6000",
  "latitude": 10.3312,
  "longitude": 123.9056,
  "pinStatus": "pending",
  "salesOrgCode": "1000",
  "salesOrgName": "SFI",
  "salesOfficeCode": "100",
  "salesOfficeName": "SFI Cebu",
  "distributionChannelCode": "41",
  "distributionChannelName": "Route Sales",
  "customerGroup1Code": "RSF",
  "customerGroup1Name": "RS Frozen",
  "customerGroup2Code": "RSS",
  "customerGroup2Name": "Sari-Sari Store",
  "customerGroupCode": "74",
  "customerGroupName": "NO GROUP",
  "typeOfBusiness": "Sole Proprietor",
  "typeOfBusinessName": "Sole Proprietor",
  "salesPartnerCode": null,
  "salesPartnerName": null,
  "paymentTermsCode": "0003",
  "paymentTermsName": "Due in 7 days",
  "creditLimit": 15000,
  "pricingProcedureCode": "2",
  "pricingProcedureName": "Standard Inclusive Tax",
  "deliveringPlantCode": "1000",
  "deliveringPlantName": "Cebu Production",
  "shipTos": [
    {
      "id": "uuid",
      "ordinal": 0,
      "sameAsCustomer": true,
      "shipToParty": "Aling Rosa Store",
      "shipToAddress": "12 Gorordo Ave, …",
      "contactPerson": "Rosa",
      "mobileNo": "09171234567",
      "email": "rosa@example.ph"
    }
  ],
  "distributorCode": null,
  "distributorName": null,
  "distributorCustomerCode": null,
  "distributionMode": null,
  "subDistributorCode": null,
  "subDistributorName": null,
  "distributorSalesman": null,
  "distributorSalesmanCode": null,
  "truckServing": null,
  "truckCode": null,
  "distributorHub": null,
  "clusterNo": null,
  "clusterName": null,
  "custodianOrgUnitId": "uuid",
  "territoryId": "uuid|null",
  "accountingCustomerId": "uuid|null",
  "legacyChannel": "41",
  "createdAt": 1794396021217,
  "updatedAt": 1794396021217
}
```

`accountingCustomerId` and `legacyChannel` are internal (do not show): `legacyChannel` is the
price-list/call-flow key (`outlets.channel`). List rows carry `id, code, customerName,
customerAddress, status, enrolmentStatus, completeness, salesOrgCode, salesOfficeCode,
distributionChannelCode/Name, customerGroup1Code/Name, customerGroup2Code/Name,
customerGroupCode/Name, municipalityName, barangayName, territoryId, territoryName`.

## 5. Errors

Envelope (contract §3): `{ "error": { "code", "message", "retryable", "details"? } }`.
Validation failures are `422` with `code: "validation_failed"`, `message` = first error's message,
and `details.errors[]`:

```json
{
  "code": "not_for_sales_org",
  "field": "distributionChannelCode",
  "label": "Distribution Channel",
  "section": "Customer Assignment",
  "message": "Distribution Channel \"30\" is not available for Sales Organization 2000."
}
```

Ship-to errors use `field: "shipTos[1].mobileNo"` and `index: 1`.

| code                   | meaning                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `required`             | `<Label> is required.`                                                                  |
| `too_long`             | over the field's max length                                                             |
| `invalid_option`       | code not in the list (or PSGC code unknown)                                             |
| `not_for_sales_org`    | Sales Office / Distribution Channel / Delivering Plant not under the Sales Organization |
| `not_for_channel`      | Customer Grp 1 not under the Distribution Channel                                       |
| `not_for_group1`       | Customer Grp 2 not under Customer Grp 1                                                 |
| `not_applicable`       | Grp 1 / Grp 2 sent where the chain has none                                             |
| `choose_parent_first`  | a dependent value sent without its parent                                               |
| `invalid_tin`          | not `###-###-###[-###]` / 9 or 12 digits                                                |
| `invalid_mobile`       | not `09XXXXXXXXX` / `+639XXXXXXXXX`                                                     |
| `invalid_email`        | not an email                                                                            |
| `invalid_coordinates`  | latitude/longitude out of range or 0,0                                                  |
| `invalid_credit_limit` | negative or not a number                                                                |
| `geography_mismatch`   | Province/Municipality/Barangay not under its parent                                     |
| `postal_code_mismatch` | Postal Code not one of the municipality's                                               |
| `ship_to_required`     | `complete` needs at least one ship-to                                                   |

Other: `400 invalid_request` (unknown field key, bad id, missing list filter), `403` (capability
or scope), `404 not_found`, `409 conflict` (duplicate code), `409 idempotency_conflict`,
`422 code_taken` / `code_locked` / `invalid_code`, `422 business_rule` (e.g. inactive customer,
self-approval of one's own field enrolment `self_verify`).

## 6. Field capture (Android lane)

Phones keep using the existing enrolment paths; add an optional **`customer`** object (the keys
of §1, no `shipTos` needed) to:

- `POST /api/v1/outlets/enrolment/propose` (body keys unchanged), and
- the offline prospect op (`payload.customer` beside `kyc`, `geo`, `photo`).

The store is created as today (provisional code, pending pin, pending enrolment) and its
customer profile is saved at `draft` with a "same as customer" ship-to (Contact Person = the
enrolment's `contactName`). `customer.distributionChannelCode` stands in for the old free-text
`channel`. The office completes it with `PUT /api/v1/customers/:id`, then approves with
`POST /api/v1/customers/:id/approve` (or the old enrolment decide route, which now also keeps the
accounting customer 1:1). The accounting customer is created at approval.

## 7. Mobile payloads (additive, current apps unaffected)

- Field bootstrap/delta `outlets[]` entries (FIELDSYNC) and van bootstrap `customers[]` entries
  keep every existing key unchanged and gain:
  - `channel`: Distribution Channel name (e.g. "Route Sales"), `null` when the store has no profile;
  - `customerMaster`: `{ salesOrgCode, distributionChannelCode, distributionChannelName,
customerGroup1Code, customerGroup1Name, customerGroup2Code, customerGroup2Name,
customerGroupCode, customerGroupName, completeness }`.
- `channelKey` (pricing/call-flow eligibility) is unchanged.
- Team reports' `channel` / people's channel scope now carry Distribution Channel names.

## 8. Analytics, targets and filters

`analytics_store_scope.channel` = Distribution Channel name and `.subchannel` = Customer Grp 1
name (old key only for stores without a profile); new columns `sales_org_code,
distribution_channel_code, customer_group1_code, customer_group2_code, customer_group2_name,
customer_group_code, customer_group_name, legacy_channel`. Every analytics `channel` filter,
group-by, store list, and the target tree (channel targets, territory channel, people's channel
scope) use those names. Web filters should offer the Distribution Channel names (e.g. from
`/api/v1/customers/reference/distribution_channel?salesOrgCode=1000`).
