import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as backend from "../../../../../packages/backend/convex/supervision/trainer_forms_model";
import {
  ProgramSheetView,
  SessionFormsView,
  TrainerFormView,
  TrainingFormsView,
} from "./trainer-forms";
import {
  formStatusTone,
  JOB_EVALUATION_SECTIONS,
  JOB_RATING_LABELS,
  objectiveLines,
  ratingList,
  ratingMap,
} from "./trainer-forms-model";

const baseForm = {
  _id: "f1",
  _creationTime: 1,
  organizationId: "sunpride",
  sessionId: "s1",
  trainerProfileId: "p1",
  traineeProfileId: "p2",
  orgUnitId: "u1",
  serviceDate: "2026-09-30",
  createdBy: "x",
  createdAt: 1,
  updatedBy: "x",
  updatedAt: 1,
};
const detail = (form: object, extra: object = {}) =>
  ({
    form: { ...baseForm, ...form },
    trainerName: "Dina",
    traineeName: "Ana",
    sessionStatus: "completed",
    gaps: [],
    canEdit: false,
    canAcknowledge: false,
    ...extra,
  }) as never;
const handlers = {
  save: vi.fn(),
  sign: vi.fn(),
  discard: vi.fn(),
  acknowledge: vi.fn(),
  onClose: vi.fn(),
};
const row = {
  formId: "f1",
  kind: "training_sheet",
  sessionId: "s1",
  serviceDate: "2026-09-30",
  status: "signed",
  trainerName: "Dina",
  traineeName: "Ana",
};
const program = {
  traineeName: "Ana",
  blocks: [
    {
      formId: "f2",
      serviceDate: "2026-09-10",
      trainerName: "Dina",
      status: "acknowledged",
      program: {
        area: "Quezon City",
        objectives: ["Basic call", "Shelf share"],
        strengths: "Knows the outlets",
        improvementAreas: "Rushes the close",
        plansForNextContact: "Practice the close",
      },
    },
  ],
  latestEvaluation: {
    formId: "f3",
    serviceDate: "2026-09-30",
    trainerName: "Dina",
    evaluation: {
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      district: "North",
      area: "QC",
      ratings: [],
      overall: 2,
      remarks: "",
    },
  },
};

describe("trainer form view rules", () => {
  it("mirrors the backend Annex G items and rating scale exactly", () => {
    expect(JSON.parse(JSON.stringify(JOB_EVALUATION_SECTIONS))).toEqual(
      JSON.parse(JSON.stringify(backend.JOB_EVALUATION_SECTIONS)),
    );
    expect(JOB_RATING_LABELS).toEqual(backend.JOB_RATING_LABELS);
  });

  it("round-trips ratings in the form's order and pads objectives to three", () => {
    const map = ratingMap([
      { item: "others.goodwill", rating: 3 },
      { item: "preparation.review_plans", rating: 1 },
    ]);
    expect(ratingList(map)).toEqual([
      { item: "preparation.review_plans", rating: 1 },
      { item: "others.goodwill", rating: 3 },
    ]);
    expect(objectiveLines(["a"])).toEqual(["a", "", ""]);
    expect(formStatusTone("acknowledged")).toBe("success");
    expect(formStatusTone("signed")).toBe("warning");
  });
});

describe("trainer form screens", () => {
  it("lets the trainer fill a training sheet draft and lists what is missing", () => {
    const html = renderToStaticMarkup(
      <TrainerFormView
        detail={detail(
          {
            kind: "training_sheet",
            status: "draft",
            sheet: { objective: "", result: "", learnings: "", nextSteps: "" },
          },
          {
            canEdit: true,
            sessionStatus: "open",
            gaps: [{ code: "objective", label: "Write the objective" }],
          },
        )}
        {...handlers}
      />,
    );
    expect(html).toContain("Training sheet · Ana · 30 Sep");
    expect(html).toContain("Annex F");
    expect(html).toContain("Complete the Work-With first");
    expect(html).toContain("Write the objective");
    for (const label of ["Objective", "Result", "Learnings", "Next steps"])
      expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain("Save and sign");
    expect(html).not.toContain(">Acknowledge<");
  });

  it("rates every Annex G item 1–4 with the overall job standard", () => {
    const html = renderToStaticMarkup(
      <TrainerFormView
        detail={detail(
          {
            kind: "job_evaluation",
            status: "draft",
            evaluation: {
              periodStart: "2026-09-01",
              periodEnd: "2026-09-30",
              district: "",
              area: "",
              ratings: [{ item: "call_procedure.close", rating: 4 }],
              remarks: "",
            },
          },
          { canEdit: true },
        )}
        {...handlers}
      />,
    );
    expect(html).toContain('aria-label="Call procedure: Close"');
    expect(html).toContain('aria-label="Others: Merchandiser management"');
    expect(html).toContain('aria-label="Overall job standard"');
    expect(html).toContain("4 · Unsatisfactory");
    expect(html).toContain("1 Excellent · 2 Good · 3 Satisfactory");
  });

  it("asks only the trainee to acknowledge a signed form, read-only", () => {
    const html = renderToStaticMarkup(
      <TrainerFormView
        detail={detail(
          {
            kind: "job_evaluation",
            status: "signed",
            signedAt: Date.parse("2026-09-30T08:00:00Z"),
            evaluationSessions: [
              { sessionId: "s0", serviceDate: "2026-09-10" },
              { sessionId: "s1", serviceDate: "2026-09-30" },
            ],
            evaluation: {
              periodStart: "2026-09-01",
              periodEnd: "2026-09-30",
              district: "North",
              area: "QC",
              ratings: [],
              overall: 2,
              remarks: "",
            },
          },
          { canAcknowledge: true },
        )}
        {...handlers}
      />,
    );
    expect(html).toContain("Work-With dates: 10 Sep, 30 Sep");
    expect(html).toContain("Waiting for Ana to acknowledge.");
    expect(html).toContain(">Acknowledge<");
    expect(html).not.toContain("Save and sign");
    expect(html).toContain("disabled");
  });

  it("shows an acknowledged training block with the trainee's Annex D history", () => {
    const html = renderToStaticMarkup(
      <TrainerFormView
        detail={detail({
          kind: "training_program",
          status: "acknowledged",
          traineeComment: "Will practise",
          program: program.blocks[0]!.program,
        })}
        history={program as never}
        {...handlers}
      />,
    );
    expect(html).toContain("Training objective 3");
    expect(html).toContain("Acknowledged by Ana: “Will practise”");
    expect(html).toContain(
      "Latest job evaluation 30 Sep by Dina: overall 2 · Good",
    );
    expect(html).toContain("Plans for next contact:");
    expect(html).not.toContain(">Acknowledge<");
  });

  it("offers the trainer only the forms the session does not have yet", () => {
    const html = renderToStaticMarkup(
      <SessionFormsView
        data={{ forms: [row], canCreate: true } as never}
        onOpen={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(html).toContain("Trainer forms");
    expect(html).toContain("Waiting for trainee");
    expect(html).not.toContain("Add training sheet");
    expect(html).toContain("Add training program");
    expect(html).toContain("Add job evaluation");
    const readOnly = renderToStaticMarkup(
      <SessionFormsView
        data={{ forms: [], canCreate: false } as never}
        onOpen={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(readOnly).toContain("No trainer forms yet");
    expect(readOnly).not.toContain("Add ");
  });

  it("lists the caller's forms to acknowledge and their training program", () => {
    const html = renderToStaticMarkup(
      <TrainingFormsView
        mine={{ toAcknowledge: [row], received: [], written: [] } as never}
        program={program as never}
        onOpen={vi.fn()}
      />,
    );
    expect(html).toContain("Waiting for your acknowledgement");
    expect(html).toContain("Training sheet · Annex F");
    expect(html).toContain("Open Training sheet of 2026-09-30");
    expect(html).toContain("My training program");
    expect(html).toContain("Rushes the close");
    expect(html).not.toContain("Forms I wrote");
    expect(
      renderToStaticMarkup(
        <ProgramSheetView
          data={{ traineeName: "Ana", blocks: [], latestEvaluation: null }}
        />,
      ),
    ).toContain("No job evaluation yet");
  });
});
