import { NextResponse, type NextRequest } from "next/server";
import { REQUEST_PATH_HEADER } from "./lib/auth/routing";

/**
 * Tells server layouts which address is being opened (path + query), so a
 * signed-out visit can send the person to `/login?next=…` and back (WEB-007).
 * Adds a request header only; nothing is redirected or blocked here.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(
    REQUEST_PATH_HEADER,
    request.nextUrl.pathname + request.nextUrl.search,
  );
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    "/((?!api/|ws|_next/|guides/|flow/|kickoff/|sw\\.js|manifest\\.webmanifest|favicon\\.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|js|css|txt|html)$).*)",
  ],
};
