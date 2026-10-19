import { NextResponse, type NextRequest } from "next/server";

const ROLES = new Set([
  "super_admin",
  "admin",
  "operations",
  "manager",
  "approver",
  "sales",
  "analyst",
  "viewer",
]);

/**
 * Development only: turns on cockpit fixture mode (demo session + contract
 * fixtures, no API) and opens `next`. `/fixture?off=1` turns it off.
 * Production builds answer 404.
 */
export function GET(request: NextRequest) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- NODE_ENV is set by Next itself.
  if (process.env.NODE_ENV === "production")
    return new NextResponse("Not found", { status: 404 });
  const url = request.nextUrl;
  const raw = url.searchParams.get("next") ?? "/today";
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/today";
  const role = url.searchParams.get("role") ?? "super_admin";
  const response = NextResponse.redirect(new URL(next, url.origin));
  if (url.searchParams.get("off") === "1") {
    response.cookies.delete("sp_fixture");
    response.cookies.delete("sp_fixture_role");
    return response;
  }
  response.cookies.set("sp_fixture", "1", { path: "/", sameSite: "lax" });
  response.cookies.set(
    "sp_fixture_role",
    ROLES.has(role) ? role : "super_admin",
    {
      path: "/",
      sameSite: "lax",
    },
  );
  return response;
}
