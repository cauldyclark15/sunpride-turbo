export function frozenQuantity(line: {
  quantityBase: string;
  quantityScale?: string;
  pieceBase?: string;
  caseBase?: string;
}) {
  if (!line.pieceBase || !line.caseBase || BigInt(line.caseBase) <= 0n)
    return "Original unit details unavailable";
  const base = BigInt(line.quantityBase),
    scale = BigInt(line.pieceBase),
    caseBase = BigInt(line.caseBase);
  if (scale <= 0n) return "Original unit details unavailable";
  return `${base / caseBase} cases + ${Number(base % caseBase) / Number(scale)} pieces`;
}
