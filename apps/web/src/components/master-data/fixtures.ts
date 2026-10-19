// Preserve the existing editor behavior fixtures while moving their transport to HTTP.
// New API contract tests exercise the actual URLs separately.
export function fixtureName(reference: unknown) {
  const path = String(reference);
  const special: Record<string, string> = {
    "org/permissions": "lib/capabilities:currentPermissions",
    "people/current": "domains/profiles:current",
    "people/invitations/list": "domains/profiles:listInvitations",
    "catalog/customers/list": "domains/masterData:customers",
    "catalog/positions": "sfa/positions:list",
    "catalog/standards": "sfa/standards:current",
    "people/devices/list": "mobile/devices:list",
    "people/devices/report": "mobile/devices:lostDeviceReport",
    "outlets/unassigned": "outlets/assignments:unassigned",
  };
  if (special[path]) return special[path];
  const parts = path.split("/");
  const action = (parts.pop() ?? "").replace(/-([a-z])/g, (_, c: string) =>
    c.toUpperCase(),
  );
  let prefix = parts.join("/");
  if (prefix === "org/teams") prefix = "teams/queries";
  else if (["org", "people", "territories", "outlets"].includes(prefix))
    prefix += "/queries";
  return `${prefix}:${action}`;
}
export function fixtureValue(path: unknown, value: unknown) {
  return ["people/invitations/list", "catalog/customers/list"].includes(
    String(path),
  ) && Array.isArray(value)
    ? { page: value, isDone: true, continueCursor: "" }
    : value;
}
