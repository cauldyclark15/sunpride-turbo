"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { carryFixture, withParams, type ParamPatch } from "./url";

/** The page's URL state: read params, build hrefs, push changes. */
export function useUrlState() {
  const search = useSearchParams();
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const params = useMemo(
    () => new URLSearchParams(search?.toString() ?? ""),
    [search],
  );
  const hrefWith = useCallback(
    (patch: ParamPatch, path = pathname) => withParams(path, params, patch),
    [params, pathname],
  );
  const set = useCallback(
    (patch: ParamPatch, options: { replace?: boolean } = {}) => {
      const href = withParams(pathname, params, patch);
      if (options.replace) router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [params, pathname, router],
  );
  const link = useCallback(
    (href: string) => carryFixture(href, params),
    [params],
  );
  return { params, pathname, hrefWith, set, link, router };
}
