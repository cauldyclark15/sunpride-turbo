const contractDirectory = new URL(
  "../packages/integration-contracts/sap/",
  import.meta.url,
);
const files = [
  "envelope.schema.json",
  "inventory.schema.json",
  "master-data.schema.json",
  "sales-order.schema.json",
];

for (const file of files) {
  const schema = (await Bun.file(
    new URL(file, contractDirectory),
  ).json()) as Record<string, unknown>;
  if (
    schema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
    typeof schema.$id !== "string" ||
    schema.type !== "object"
  ) {
    throw new Error(`${file} is not a versioned JSON Schema object`);
  }
}

console.log(`Validated ${files.length} SAP integration contracts.`);
