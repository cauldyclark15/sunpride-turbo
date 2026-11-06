"use client";

/**
 * "Take a photo" for reasons that need one (damaged, rejected). The server records how many photos
 * were taken; uploading the pictures themselves is not wired yet (see the XFER report).
 */
export function PhotoCount({
  count,
  onChange,
  label = "Photo",
}: {
  count: number;
  onChange: (count: number) => void;
  label?: string;
}) {
  return (
    <label className="grid gap-1 text-xs font-medium uppercase text-muted">
      {label}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="min-h-12 text-sm normal-case text-foreground"
        onChange={(e) => onChange(e.target.files?.length ?? 0)}
      />
      <span className="text-xs normal-case">
        {count > 0
          ? `${count} photo${count === 1 ? "" : "s"} taken`
          : "No photo yet"}
      </span>
    </label>
  );
}
