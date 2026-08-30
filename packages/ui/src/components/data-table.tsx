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
}: {
  columns: DataColumn<Row>[];
  rows: Row[];
  empty: ReactNode;
}) {
  if (rows.length === 0) return <>{empty}</>;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse text-left text-sm">
          <thead className="bg-surface-secondary text-xs font-medium text-muted">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`px-4 py-2.5 ${column.align === "right" ? "text-right" : ""}`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-separator">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-surface-secondary/70">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`px-4 py-3 text-foreground ${column.align === "right" ? "text-right tabular-nums" : ""}`}
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
