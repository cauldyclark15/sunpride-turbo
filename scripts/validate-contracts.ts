const contractDirectory = new URL(
  "../packages/integration-contracts/sap/",
  import.meta.url,
);
const files = [
  "envelope.schema.json",
  "inventory.schema.json",
  "inventory-movement.schema.json",
  "master-data.schema.json",
  "sales-order.schema.json",
];

// F-001 every versioned interface is included, not only the retired connector subset.
files.push(
  ...Array.from(
    new Bun.Glob("v1/*.schema.json").scanSync({
      cwd: new URL(contractDirectory).pathname,
    }),
  ).sort(),
);

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
