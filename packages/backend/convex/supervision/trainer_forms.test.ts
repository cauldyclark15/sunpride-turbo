import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  formGaps,
  JOB_EVALUATION_ITEMS,
  JOB_EVALUATION_SECTIONS,
  sectionAverages,
  validPeriod,
  type JobEvaluationContent,
} from "./trainer_forms_model";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
// Wednesday 2026-09-30, 15:00 Manila.
const date = "2026-09-30";
const now = Date.parse("2026-09-30T07:00:00Z");
const ISSUER = "https://auth.test";
const subject = (name: string) => `${ISSUER}|${name}`;

afterEach(() => {
  vi.useRealTimers();
});

const program = {
  area: "Quezon City",
  objectives: ["Basic call procedure", "  ", "Shelf share"],
  strengths: "Knows the outlets",
  improvementAreas: "Rushes the close",
  plansForNextContact: "Practice the close at two stalls",
};
const sheet = {
  objective: "Close with a stack order",
  result: "Two of five outlets took the stack",
  learnings: "Lead with the promo",
  nextSteps: "Repeat on Friday's route",
};
/** One rating in every section, plus the overall standard. */
const fullRatings = JOB_EVALUATION_SECTIONS.map((section, i) => ({
  item: `${section.code}.${section.items[0][0]}`,
  rating: ((i % 4) + 1) as 1 | 2 | 3 | 4,
}));
const evaluation: JobEvaluationContent = {
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  district: "North",
  area: "Quezon City",
  ratings: fullRatings,
  overall: 2,
  remarks: "Steady",
};

describe("trainer form rules", () => {
  it("lists every Annex G item once with its section", () => {
    const count = JOB_EVALUATION_SECTIONS.reduce(
      (sum, section) => sum + section.items.length,
      0,
    );
    expect(JOB_EVALUATION_ITEMS.size).toBe(count);
    expect(JOB_EVALUATION_ITEMS.has("call_procedure.next_coverage")).toBe(true);
    expect(JOB_EVALUATION_ITEMS.has("preparation.review_plans")).toBe(true);
    expect(JOB_EVALUATION_SECTIONS.map((row) => row.code)).toEqual([
      "preparation",
      "trade_coverage",
      "call_procedure",
      "closing_day",
      "area_management",
      "sales_qualities",
      "others",
    ]);
  });

  it("asks for every field of the training program and training sheet", () => {
    expect(
      formGaps(
        "training_program",
        {
          program: {
            area: "",
            objectives: [" "],
            strengths: "",
            improvementAreas: "",
            plansForNextContact: "",
          },
        },
        date,
      ),
    ).toEqual([
      "area",
      "objectives",
      "strengths",
      "improvement_areas",
      "next_contact",
    ]);
    expect(formGaps("training_program", { program }, date)).toEqual([]);
    expect(
      formGaps("training_sheet", { sheet: { ...sheet, learnings: "" } }, date),
    ).toEqual(["learnings"]);
    expect(formGaps("training_sheet", { sheet }, date)).toEqual([]);
  });

  it("needs a period around the session, every section rated and the overall", () => {
    expect(formGaps("job_evaluation", { evaluation }, date)).toEqual([]);
    expect(
      formGaps(
        "job_evaluation",
        {
          evaluation: {
            ...evaluation,
            periodEnd: "2026-09-29",
            area: "",
            ratings: fullRatings.slice(1),
            overall: undefined,
          },
        },
        date,
      ),
    ).toEqual(["period", "area", "section_unrated", "overall"]);
    expect(validPeriod("2026-09-01", "2026-09-30")).toBe(true);
    expect(validPeriod("2026-09-30", "2026-09-01")).toBe(false);
    expect(validPeriod("2026-01-01", "2026-12-31")).toBe(false);
    expect(validPeriod("2026-02-30", "2026-03-01")).toBe(false);
  });

  it("averages ratings per section (1 Excellent … 4 Unsatisfactory)", () => {
    const rows = sectionAverages([
      { item: "preparation.review_plans", rating: 1 },
      { item: "preparation.vehicle_check", rating: 2 },
    ]);
    expect(rows[0]).toMatchObject({ section: "preparation", average: 1.5 });
    expect(rows[1]).toMatchObject({ rated: 0, average: null });
  });
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const t: T = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const since = now - 60 * 24 * HOUR;
    const unit = (code: string, parentId?: Id<"orgUnits">) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: parentId ? "REGION" : "NATIONAL",
        ...(parentId ? { parentId } : {}),
        status: "active",
        effectiveFrom: since,
        createdAt: since,
        updatedAt: since,
      });
    const root = await unit("SUNPRIDE");
    const regionA = await unit("A", root);
    const regionB = await unit("B", root);
    const person = async (
      name: string,
      role: "sales" | "manager",
      orgUnitId: Id<"orgUnits">,
    ) => {
      const id = await ctx.db.insert("profiles", {
        authSubject: subject(name),
        name,
        email: `${name}@test.local`,
        role,
        status: "active",
        orgUnitId,
        updatedAt: since,
      });
      await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId,
        role,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      return id;
    };
    const managerA = await person("managerA", "manager", regionA);
    const managerB = await person("managerB", "manager", regionB);
    const dina = await person("Dina", "sales", regionA);
    const ana = await person("Ana", "sales", regionA);
    const eli = await person("Eli", "sales", regionA);
    const session = (
      serviceDate: string,
      status: "open" | "completed" | "cancelled",
      trainee = ana,
    ) =>
      ctx.db.insert("workWithSessions", {
        organizationId: "sunpride",
        trainerProfileId: dina,
        traineeProfileId: trainee,
        orgUnitId: regionA,
        serviceDate,
        objective: "training",
        mode: "booking",
        status,
        observations: [],
        createdBy: subject("Dina"),
        createdAt: since,
        updatedBy: subject("Dina"),
        updatedAt: since,
      });
    return {
      managerA,
      managerB,
      dina,
      ana,
      eli,
      completed: await session(date, "completed"),
      earlier: await session("2026-09-10", "completed"),
      openEarlier: await session("2026-09-12", "open"),
      otherTrainee: await session("2026-09-15", "completed", eli),
      open: await session("2026-09-29", "open"),
      cancelled: await session("2026-09-28", "cancelled"),
    };
  });
  const as = (name: string) =>
    t.withIdentity({
      subject: name,
      issuer: ISSUER,
      tokenIdentifier: subject(name),
      email: `${name}@test.local`,
      name,
    });
  return { t, ids, as };
}

describe("trainer forms", () => {
  it("lets the trainer fill and sign a training sheet, then the trainee acknowledge it", async () => {
    const { ids, as } = await fixture();
    const dina = as("Dina");
    const formId = await dina.mutation(api.supervision.trainer_forms.create, {
      sessionId: ids.completed,
      kind: "training_sheet",
    });
    await expect(
      dina.mutation(api.supervision.trainer_forms.create, {
        sessionId: ids.completed,
        kind: "training_sheet",
      }),
    ).rejects.toThrow("already has that form");
    await expect(
      dina.mutation(api.supervision.trainer_forms.sign, { formId }),
    ).rejects.toThrow("Write the objective");
    await expect(
      dina.mutation(api.supervision.trainer_forms.update, {
        formId,
        program,
      }),
    ).rejects.toThrow("does not belong");
    await dina.mutation(api.supervision.trainer_forms.update, {
      formId,
      sheet: { ...sheet, objective: `  ${sheet.objective}  ` },
    });
    // The trainee cannot acknowledge before the trainer signs.
    await expect(
      as("Ana").mutation(api.supervision.trainer_forms.acknowledge, {
        formId,
      }),
    ).rejects.toThrow("not signed");
    expect(
      (await as("Ana").query(api.supervision.trainer_forms.mine, {}))
        .toAcknowledge,
    ).toEqual([]);
    await dina.mutation(api.supervision.trainer_forms.sign, { formId });
    await expect(
      dina.mutation(api.supervision.trainer_forms.update, { formId, sheet }),
    ).rejects.toThrow("signed form cannot be changed");
    await expect(
      dina.mutation(api.supervision.trainer_forms.discard, { formId }),
    ).rejects.toThrow("cannot be discarded");

    const ana = as("Ana");
    const waiting = await ana.query(api.supervision.trainer_forms.mine, {});
    expect(waiting.toAcknowledge).toMatchObject([
      { formId, kind: "training_sheet", trainerName: "Dina" },
    ]);
    const before = await ana.query(api.supervision.trainer_forms.detail, {
      formId,
    });
    expect(before.canAcknowledge).toBe(true);
    expect(before.canEdit).toBe(false);
    expect(before.form.sheet?.objective).toBe(sheet.objective);
    // Only the trainee signs for the trainee.
    await expect(
      as("managerA").mutation(api.supervision.trainer_forms.acknowledge, {
        formId,
      }),
    ).rejects.toThrow("not found");
    await ana.mutation(api.supervision.trainer_forms.acknowledge, {
      formId,
      comment: "Will practise",
    });
    await expect(
      ana.mutation(api.supervision.trainer_forms.acknowledge, { formId }),
    ).rejects.toThrow("already acknowledged");
    const after = await ana.query(api.supervision.trainer_forms.detail, {
      formId,
    });
    expect(after.form).toMatchObject({
      status: "acknowledged",
      traineeComment: "Will practise",
      acknowledgedBy: subject("Ana"),
      signedBy: subject("Dina"),
    });
    const mine = await ana.query(api.supervision.trainer_forms.mine, {});
    expect(mine.toAcknowledge).toEqual([]);
    expect(mine.received).toHaveLength(1);
  });

  it("refuses forms on sessions the caller does not train, cancelled sessions and unsigned work", async () => {
    const { ids, as } = await fixture();
    await expect(
      as("Ana").mutation(api.supervision.trainer_forms.create, {
        sessionId: ids.completed,
        kind: "training_sheet",
      }),
    ).rejects.toThrow("not found");
    await expect(
      as("Dina").mutation(api.supervision.trainer_forms.create, {
        sessionId: ids.cancelled,
        kind: "training_sheet",
      }),
    ).rejects.toThrow("cancelled");
    const formId = await as("Dina").mutation(
      api.supervision.trainer_forms.create,
      { sessionId: ids.open, kind: "training_program" },
    );
    await as("Dina").mutation(api.supervision.trainer_forms.update, {
      formId,
      program,
    });
    await expect(
      as("Dina").mutation(api.supervision.trainer_forms.sign, { formId }),
    ).rejects.toThrow("Complete the Work-With session");
    await expect(
      as("Dina").mutation(api.supervision.trainer_forms.update, {
        formId,
        program: { ...program, objectives: ["a", "b", "c", "d"] },
      }),
    ).rejects.toThrow("at most 3");
    // A draft can be thrown away.
    await as("Dina").mutation(api.supervision.trainer_forms.discard, {
      formId,
    });
    await expect(
      as("Dina").query(api.supervision.trainer_forms.detail, { formId }),
    ).rejects.toThrow("not found");
  });

  it("rates the job evaluation 1–4 and freezes the completed session dates in its period", async () => {
    const { ids, as } = await fixture();
    const dina = as("Dina");
    const formId = await dina.mutation(api.supervision.trainer_forms.create, {
      sessionId: ids.completed,
      kind: "job_evaluation",
    });
    const draft = await dina.query(api.supervision.trainer_forms.detail, {
      formId,
    });
    expect(draft.form.evaluation).toMatchObject({
      periodStart: date,
      periodEnd: date,
    });
    await expect(
      dina.mutation(api.supervision.trainer_forms.update, {
        formId,
        evaluation: {
          ...evaluation,
          ratings: [{ item: "preparation.dancing", rating: 1 }],
        },
      }),
    ).rejects.toThrow("Unknown job evaluation item");
    await expect(
      dina.mutation(api.supervision.trainer_forms.update, {
        formId,
        evaluation: {
          ...evaluation,
          ratings: [fullRatings[0]!, fullRatings[0]!],
        },
      }),
    ).rejects.toThrow("only once");
    await dina.mutation(api.supervision.trainer_forms.update, {
      formId,
      evaluation: { ...evaluation, overall: undefined },
    });
    await expect(
      dina.mutation(api.supervision.trainer_forms.sign, { formId }),
    ).rejects.toThrow("overall job standard");
    await dina.mutation(api.supervision.trainer_forms.update, {
      formId,
      evaluation,
    });
    await dina.mutation(api.supervision.trainer_forms.sign, { formId });
    const signed = await as("managerA").query(
      api.supervision.trainer_forms.detail,
      { formId },
    );
    // Completed sessions with this trainee only — not the open, cancelled or other one.
    expect(
      signed.form.evaluationSessions?.map((row) => row.serviceDate).sort(),
    ).toEqual(["2026-09-10", date]);
    expect(signed.form.evaluation?.overall).toBe(2);
  });

  it("assembles the trainee's Annex D from signed blocks with the latest job evaluation", async () => {
    const { ids, as } = await fixture();
    const dina = as("Dina");
    const sign = async (
      sessionId: Id<"workWithSessions">,
      kind: "training_program" | "job_evaluation",
      body: object,
    ) => {
      const formId = await dina.mutation(api.supervision.trainer_forms.create, {
        sessionId,
        kind,
      });
      await dina.mutation(api.supervision.trainer_forms.update, {
        formId,
        ...body,
      });
      await dina.mutation(api.supervision.trainer_forms.sign, { formId });
      return formId;
    };
    await sign(ids.earlier, "training_program", {
      program: { ...program, area: "Earlier" },
    });
    await sign(ids.completed, "training_program", { program });
    const evaluationId = await sign(ids.completed, "job_evaluation", {
      evaluation,
    });
    // A draft block stays with its trainer.
    await dina.mutation(api.supervision.trainer_forms.create, {
      sessionId: ids.open,
      kind: "training_program",
    });
    const sheetView = await as("Ana").query(
      api.supervision.trainer_forms.program,
      { traineeProfileId: ids.ana },
    );
    expect(sheetView.traineeName).toBe("Ana");
    expect(sheetView.blocks.map((row) => row.serviceDate)).toEqual([
      date,
      "2026-09-10",
    ]);
    expect(sheetView.blocks[0]!.program.objectives).toEqual([
      "Basic call procedure",
      "Shelf share",
    ]);
    expect(sheetView.latestEvaluation?.formId).toBe(evaluationId);
    // The supervisor over the unit reads it; one outside the scope and a stranger do not.
    expect(
      (
        await as("managerA").query(api.supervision.trainer_forms.program, {
          traineeProfileId: ids.ana,
        })
      ).blocks,
    ).toHaveLength(2);
    await expect(
      as("managerB").query(api.supervision.trainer_forms.program, {
        traineeProfileId: ids.ana,
      }),
    ).rejects.toThrow("not found");
    await expect(
      as("Eli").query(api.supervision.trainer_forms.program, {
        traineeProfileId: ids.ana,
      }),
    ).rejects.toThrow("not found");
  });

  it("shows a session's forms to its people and supervisors in scope only", async () => {
    const { ids, as } = await fixture();
    await as("Dina").mutation(api.supervision.trainer_forms.create, {
      sessionId: ids.completed,
      kind: "training_sheet",
    });
    const own = await as("Dina").query(
      api.supervision.trainer_forms.forSession,
      { sessionId: ids.completed },
    );
    expect(own.canCreate).toBe(true);
    expect(own.forms).toMatchObject([
      { kind: "training_sheet", status: "draft" },
    ]);
    const supervisor = await as("managerA").query(
      api.supervision.trainer_forms.forSession,
      { sessionId: ids.completed },
    );
    expect(supervisor.canCreate).toBe(false);
    expect(supervisor.forms).toHaveLength(1);
    await expect(
      as("managerB").query(api.supervision.trainer_forms.forSession, {
        sessionId: ids.completed,
      }),
    ).rejects.toThrow("not found");
    await expect(
      as("Eli").query(api.supervision.trainer_forms.forSession, {
        sessionId: ids.completed,
      }),
    ).rejects.toThrow("not found");
  });

  it("exercises every trainerForms index", async () => {
    const { t, ids, as } = await fixture();
    const formId = await as("Dina").mutation(
      api.supervision.trainer_forms.create,
      { sessionId: ids.completed, kind: "training_sheet" },
    );
    await t.run(async (ctx) => {
      const form = (await ctx.db.get(formId))!;
      const found = [
        await ctx.db
          .query("trainerForms")
          .withIndex("by_sessionId_and_kind", (q) =>
            q.eq("sessionId", form.sessionId).eq("kind", form.kind),
          )
          .first(),
        await ctx.db
          .query("trainerForms")
          .withIndex("by_trainerProfileId_and_serviceDate", (q) =>
            q
              .eq("trainerProfileId", form.trainerProfileId)
              .eq("serviceDate", date),
          )
          .first(),
        await ctx.db
          .query("trainerForms")
          .withIndex("by_traineeProfileId_and_serviceDate", (q) =>
            q
              .eq("traineeProfileId", form.traineeProfileId)
              .eq("serviceDate", date),
          )
          .first(),
        await ctx.db
          .query("trainerForms")
          .withIndex("by_orgUnitId_and_serviceDate", (q) =>
            q.eq("orgUnitId", form.orgUnitId).eq("serviceDate", date),
          )
          .first(),
      ];
      expect(found.map((row) => row?._id)).toEqual([
        formId,
        formId,
        formId,
        formId,
      ]);
    });
  });
});
