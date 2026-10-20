/** F-309: new deduction value, NOT a reconstruction of historical open balances.
 * Every bucket uses the caller-authorized remittance receipt date in Manila.
 * @param {any[]} rows @param {number} now */
export function deductionFlow(rows, now) {
  const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const end = Date.parse(`${today}T00:00:00+08:00`) + 86400_000;
  const weekly = Array.from({ length: 8 }, (_, i) => {
    const from = end - (8 - i) * 7 * 86400_000,
      to = from + 7 * 86400_000;
    const matching = rows.filter((r) => {
      const received = Date.parse(
        `${new Date(r.received_on).toISOString().slice(0, 10)}T00:00:00+08:00`,
      );
      return received >= from && received < to;
    });
    return {
      from: new Date(from + 8 * 3600_000).toISOString().slice(0, 10),
      amountCentavos: matching.reduce((sum, r) => sum + r.amountCentavos, 0),
      count: matching.length,
    };
  });
  return {
    weekly,
    last28Centavos: weekly
      .slice(4)
      .reduce((sum, w) => sum + w.amountCentavos, 0),
    prior28Centavos: weekly
      .slice(0, 4)
      .reduce((sum, w) => sum + w.amountCentavos, 0),
  };
}
