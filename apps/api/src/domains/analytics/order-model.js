import { fail } from "../orders/validation.js";
import { suggestLine } from "./suggested-order.js";

/** Canonical availability integration. The caller has already gated current outlet ownership.
 * Only current retained approved models may replace the shared rule; incomplete observations retain it.
 * @param {any} ctx @param {any} input @param {any} rule */
export async function canonicalModelSuggestion(ctx, input, rule) {
  if (
    !input.offtake ||
    input.stockBase == null ||
    input.historyDailyBase == null
  )
    return rule;
  const candidates =
    await ctx.db`select * from analytics_model_versions where purpose='suggested_order' and status='approved' and org_unit_id=${input.owner} and configuration->>'outletId'=${input.outletId} and configuration->>'productId'=${input.productId} and (not sample or ${input.sample === true}) order by version desc limit 2`;
  if (candidates.length !== 1) return rule;
  const model = candidates[0],
    ids = model.configuration.datasetIds;
  if (!Array.isArray(ids) || !ids.length) return rule;
  const [{ count }] =
    await ctx.db`select count(*) as count from analytics_ai_dataset_items where id in ${ctx.db(ids)} and org_unit_id=${input.owner} and outlet_id=${input.outletId} and product_id=${input.productId} and retain_until>now()`;
  if (Number(count) !== ids.length) return rule;
  const angle =
    (2 *
      Math.PI *
      ((Date.parse(input.day + "T00:00:00Z") / 86400000) % 365.25)) /
    365.25;
  try {
    const prediction = predictOrder(model.artifact, {
      historyDailyBase: input.historyDailyBase,
      offtakeDailyBase: input.offtake.quantityBase / input.offtake.days,
      seasonSin: Math.sin(angle),
      seasonCos: Math.cos(angle),
      promotionUpliftPct: input.upliftPct,
      stockBase: input.stockBase,
      coverDays: input.coverDays,
    });
    const quantityBase = Math.max(prediction, input.minimumBase ?? 0);
    return {
      ...rule,
      quantityBase,
      status: quantityBase ? "suggest" : "enough_stock",
      reasons: [
        `${model.sample ? "Sample " : ""}Reviewed order model v${model.version}; confirm the proposed quantity`,
        ...rule.reasons,
      ],
      modelVersion: model.version,
    };
  } catch {
    return rule;
  }
}

export const ORDER_FEATURES = [
  "historyDailyBase",
  "offtakeDailyBase",
  "seasonSin",
  "seasonCos",
  "promotionUpliftPct",
  "stockBase",
  "coverDays",
];
/** Explicit input contract: quantities are frozen base units, never mixed cases/pieces.
 * @param {any} row */
export function orderFeatures(row) {
  const v = ORDER_FEATURES.map((key) => Number(row[key]));
  if (
    ORDER_FEATURES.some((key) => row[key] == null) ||
    v.some((n) => !Number.isFinite(n)) ||
    v.some((n, i) => ![2, 3].includes(i) && n < 0) ||
    Math.abs(v[2]) > 1 ||
    Math.abs(v[3]) > 1 ||
    v[6] > 180 ||
    v.some((n) => Math.abs(n) > 1e9)
  )
    fail(
      "Complete bounded purchase, offtake, seasonal, promotion and stock features are required",
    );
  return v;
}
/** Ridge regression fitted only on the earlier training partition; chronological holdout is untouched.
 * @param {any[]} rows */
export function trainOrderModel(rows) {
  if (rows.length > 2000)
    fail("Training supports at most 2,000 reviewed examples");
  const sorted = [...rows].sort(
    (a, b) => +new Date(a.observed_at) - +new Date(b.observed_at),
  );
  const train = sorted.filter((r) => r.split === "train"),
    test = sorted.filter((r) => r.split === "temporal_holdout");
  if (
    train.length < 8 ||
    test.length < 2 ||
    +new Date(train.at(-1).observed_at) >= +new Date(test[0].observed_at)
  )
    fail(
      "Use at least eight earlier training examples and two later temporal holdouts",
    );
  const examples = train.map((r) => orderFeatures(r.annotations));
  for (const row of [...train, ...test])
    if (
      !Number.isSafeInteger(row.annotations.nextOrderBase) ||
      row.annotations.nextOrderBase < 0 ||
      row.annotations.nextOrderBase > 1e9
    )
      fail("Ground-truth next order must be nonnegative integer base units");
  const means = ORDER_FEATURES.map(
    (_, i) => examples.reduce((n, x) => n + x[i], 0) / examples.length,
  );
  const scales = means.map(
    (m, i) =>
      Math.sqrt(
        examples.reduce((n, x) => n + (x[i] - m) ** 2, 0) / examples.length,
      ) || 1,
  );
  const xs = examples.map((x) => [
    1,
    ...x.map((v, i) => (v - means[i]) / scales[i]),
  ]);
  const size = means.length + 1,
    weights = Array(size).fill(0);
  // Coordinate descent solves the convex ridge objective; no opaque remote training service.
  for (let step = 0; step < 200; step++)
    for (let j = 0; j < size; j++) {
      let numerator = 0,
        denominator = j === 0 ? 0 : 1;
      for (let i = 0; i < xs.length; i++) {
        const other = xs[i].reduce(
          (n, v, k) => n + (k === j ? 0 : v * weights[k]),
          0,
        );
        numerator += xs[i][j] * (train[i].annotations.nextOrderBase - other);
        denominator += xs[i][j] ** 2;
      }
      weights[j] = numerator / denominator;
    }
  const artifact = {
    means,
    scales,
    weights,
    features: ORDER_FEATURES,
    definitionVersion: "ridge-base-units/v1",
  };
  const evaluated = test.map((r) => {
    const actual = r.annotations.nextOrderBase,
      predicted = predictOrder(artifact, r.annotations);
    const a = r.annotations,
      baseline = Math.max(
        0,
        Math.ceil(
          a.historyDailyBase * (1 + a.promotionUpliftPct / 100) * a.coverDays -
            a.stockBase,
        ),
      );
    return { actual, predicted, baseline };
  });
  const mae =
    evaluated.reduce((n, r) => n + Math.abs(r.predicted - r.actual), 0) /
    test.length;
  const baselineMae =
    evaluated.reduce((n, r) => n + Math.abs(r.baseline - r.actual), 0) /
    test.length;
  return {
    artifact,
    metrics: {
      trainCount: train.length,
      holdoutCount: test.length,
      mae,
      baselineMae,
      improvesBaseline: mae < baselineMae,
      trainThrough: train.at(-1).observed_at,
      holdoutFrom: test[0].observed_at,
      evaluated,
    },
  };
}
/** @param {any} artifact @param {any} features */
export function predictOrder(artifact, features) {
  const x = orderFeatures(features);
  const result =
    artifact.weights[0] +
    x.reduce(
      (n, v, i) =>
        n +
        ((v - artifact.means[i]) / artifact.scales[i]) *
          artifact.weights[i + 1],
      0,
    );
  if (!Number.isFinite(result)) fail("Model output is unavailable");
  return Math.min(1e9, Math.max(0, Math.ceil(result)));
}
/** Governed model replaces the Wave 2 quantity only with complete current inputs; otherwise keep the existing rule.
 * @param {any} model @param {any} f @param {any} settings */
export function modelSuggestion(model, f, settings) {
  const fallback = suggestLine(f, settings);
  if (
    !model ||
    model.status !== "approved" ||
    model.sample ||
    f.offtakeDailyBase == null
  )
    return { ...fallback, modelStatus: "rule_fallback" };
  const angle =
    (2 *
      Math.PI *
      ((Date.parse(settings.asOfDate + "T00:00:00Z") / 86400000) % 365.25)) /
    365.25;
  try {
    const quantity = predictOrder(model.artifact, {
      historyDailyBase: f.historyQuantity / settings.historyDays,
      offtakeDailyBase: f.offtakeDailyBase,
      seasonSin: Math.sin(angle),
      seasonCos: Math.cos(angle),
      promotionUpliftPct: f.upliftPct ?? 0,
      stockBase: f.observation?.quantity,
      coverDays: settings.nextVisitDays + settings.leadTimeDays,
    });
    const capped =
      f.available == null
        ? quantity
        : Math.min(quantity, Math.max(0, Math.floor(f.available)));
    return {
      quantity: capped,
      status: capped ? "suggest" : "enough_stock",
      reason: `Reviewed model v${model.version}; temporal holdout MAE ${model.metrics.mae.toFixed(2)} base units; confirm before ordering`,
      modelStatus: "model",
      modelVersion: model.version,
    };
  } catch {
    return { ...fallback, modelStatus: "rule_fallback" };
  }
}
