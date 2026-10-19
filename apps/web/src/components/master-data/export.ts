import { apiFetch } from "../../lib/api";
import { orgQueryParams } from "./api";
import type { Page } from "./model";

export function csvText(rows: readonly (readonly unknown[])[]) {
  const cell = (value: unknown) => {
    const text = value == null ? "" : String(value);
    const normalized = Array.from(text)
      .filter((char) => char.charCodeAt(0) > 31)
      .join("")
      .trimStart();
    const safe = /^[=+@-]/.test(normalized) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return (
    "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n"
  );
}

/** Never export only the visible page. Refuse cursor cycles/overflow and only download after every page succeeds. */
export async function collectExport<T>(
  path: string,
  query: Record<string, unknown>,
  read = (cursor: string | null) =>
    apiFetch<Page<T>>(`/api/v1/${path}`, {
      query: orgQueryParams({
        ...query,
        paginationOpts: { numItems: 100, cursor },
      }),
    }),
) {
  const rows: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const result = await read(cursor);
    rows.push(...result.page);
    if (result.isDone) return rows;
    if (!result.continueCursor || seen.has(result.continueCursor))
      throw new Error("Export did not finish. No file was downloaded.");
    seen.add(result.continueCursor);
    cursor = result.continueCursor;
  }
  throw new Error("Export exceeds the supported size. Narrow the filters.");
}

export function downloadCsv(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
