import type { ReactNode } from "react";

export type DataColumn<Row> = {
  key: string;
  label: string;
  render: (row: Row) => ReactNode;
  align?: "left" | "right";
};

export function DataTable<Row extends { id: string }>({
  columns,
  rows,
  empty,
  bare = false,
}: {
  columns: DataColumn<Row>[];
  rows: Row[];
  empty: ReactNode;
  bare?: boolean;
}) {
  if (rows.length === 0) return <>{empty}</>;
  return (
    <div
      className={
        bare
          ? "overflow-hidden"
          : "overflow-hidden rounded-2xl border border-border bg-surface"
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="text-[11px] font-medium uppercase tracking-wide text-muted">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`border-b border-separator px-4 py-3 ${column.align === "right" ? "text-right" : ""}`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-separator">
            {rows.map((row) => (
              <tr key={row.id}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`h-[52px] px-4 py-2 text-foreground ${column.align === "right" ? "text-right tabular-nums" : ""}`}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
