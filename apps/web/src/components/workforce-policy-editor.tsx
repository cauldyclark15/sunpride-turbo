"use client";
/** F-209/F-222: plain form controls edit the effective server policy; JSON is an optional interchange view. */
type Field = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  maxLength: number;
  options?: string[];
};
type Config = {
  fields: Field[];
  dayStartMinutes: number;
  dayEndMinutes: number;
  maxAccuracyMeters: number;
  maxFixAgeSeconds: number;
  maxShiftHours: number;
  dedupeRadiusMeters: number;
};
export function WorkforcePolicyEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  let c: Config;
  try {
    c = JSON.parse(value) as Config;
    if (
      !c ||
      !Array.isArray(c.fields) ||
      c.fields.some(
        (f) =>
          !f ||
          typeof f.key !== "string" ||
          typeof f.label !== "string" ||
          typeof f.type !== "string" ||
          (f.type === "select" && !Array.isArray(f.options)),
      )
    )
      throw new Error("Invalid shape");
  } catch {
    return (
      <label>
        Correct the advanced policy JSON
        <textarea
          rows={10}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  }
  const update = (patch: Partial<Config>) =>
    onChange(JSON.stringify({ ...c, ...patch }, null, 2));
  const field = (index: number, patch: Partial<Field>) =>
    update({
      fields: c.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    });
  const minutes = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const clock = (n: number) =>
    `${Math.floor(n / 60)
      .toString()
      .padStart(2, "0")}:${(n % 60).toString().padStart(2, "0")}`;
  const btn =
    "rounded-[10px] border border-border px-3 py-2 text-sm disabled:opacity-40";
  return (
    <div className="grid gap-4">
      <h4 className="font-medium">Prospect KYC fields</h4>
      {c.fields.map((f, i) => {
        const core = ["address", "channel", "contactName"].includes(f.key);
        return (
          <fieldset
            key={f.key}
            className="grid gap-2 rounded-xl border border-border p-3"
          >
            <legend className="px-1 text-sm">Field {i + 1}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                Label
                <input
                  required
                  value={f.label}
                  onChange={(e) => field(i, { label: e.target.value })}
                />
              </label>
              <label className="grid gap-1 text-sm">
                Entry type
                <select
                  value={f.type}
                  onChange={(e) =>
                    field(i, {
                      type: e.target.value,
                      options:
                        e.target.value === "select" ? ["SAMPLE choice"] : [],
                    })
                  }
                >
                  <option value="text">Text</option>
                  <option value="select">Choose from a list</option>
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={f.required}
                  disabled={core}
                  onChange={(e) => field(i, { required: e.target.checked })}
                />
                Required
              </label>
              <label className="text-sm">
                Maximum characters
                <input
                  className="ml-2 w-24"
                  type="number"
                  min={1}
                  max={500}
                  value={f.maxLength}
                  onChange={(e) =>
                    field(i, { maxLength: Number(e.target.value) })
                  }
                />
              </label>
              <button
                className={btn}
                type="button"
                disabled={core}
                onClick={() =>
                  update({ fields: c.fields.filter((_, n) => n !== i) })
                }
              >
                Remove field
              </button>
            </div>
            {f.type === "select" && (
              <label className="grid gap-1 text-sm">
                Choices, one per line
                <textarea
                  rows={3}
                  value={(f.options ?? []).join("\n")}
                  onChange={(e) =>
                    field(i, {
                      options: e.target.value
                        .split("\n")
                        .filter((x) => x !== ""),
                    })
                  }
                />
              </label>
            )}
            {core && (
              <p className="text-xs text-muted">
                Required by the canonical master-data enrolment.
              </p>
            )}
          </fieldset>
        );
      })}
      <button
        className={btn}
        type="button"
        disabled={c.fields.length >= 12}
        onClick={() => {
          let n = 1;
          while (c.fields.some((f) => f.key === `kyc${n}`)) n++;
          update({
            fields: [
              ...c.fields,
              {
                key: `kyc${n}`,
                label: "New KYC field",
                type: "text",
                required: false,
                maxLength: 200,
                options: [],
              },
            ],
          });
        }}
      >
        Add KYC field
      </button>
      <h4 className="font-medium">Capture window and evidence checks</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          Daily capture starts, Manila
          <input
            type="time"
            value={clock(c.dayStartMinutes)}
            onChange={(e) =>
              update({ dayStartMinutes: minutes(e.target.value) })
            }
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={c.dayEndMinutes === 1440}
            onChange={(e) =>
              update({ dayEndMinutes: e.target.checked ? 1440 : 1320 })
            }
          />
          Capture through the end of the Manila day
        </label>
        {c.dayEndMinutes !== 1440 && (
          <label className="grid gap-1 text-sm">
            Daily capture ends, Manila
            <input
              type="time"
              value={clock(c.dayEndMinutes)}
              onChange={(e) =>
                update({ dayEndMinutes: minutes(e.target.value) })
              }
            />
          </label>
        )}
        {(
          [
            [
              "maxAccuracyMeters",
              "Flag location accuracy above, metres",
              1,
              5000,
            ],
            ["maxFixAgeSeconds", "Maximum photo/location age, seconds", 1, 900],
            ["maxShiftHours", "Flag clock span above, hours", 1, 36],
            [
              "dedupeRadiusMeters",
              "Nearby master candidate radius, metres",
              1,
              500,
            ],
          ] as const
        ).map(([key, label, min, max]) => (
          <label className="grid gap-1 text-sm" key={key}>
            {label}
            <input
              type="number"
              min={min}
              max={max}
              value={c[key]}
              onChange={(e) => update({ [key]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
      <details>
        <summary className="cursor-pointer text-sm">
          Advanced policy interchange JSON
        </summary>
        <textarea
          aria-label="Advanced field form policy JSON"
          rows={12}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </details>
    </div>
  );
}
