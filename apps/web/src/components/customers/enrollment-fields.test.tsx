import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EnrollmentFields } from "./enrollment-fields";
import {
  emptyDraft,
  draftFromCustomer,
  toPayload,
  checkDraft,
  indexReference,
  type Customer,
} from "./model";
import { reorderEnrollment } from "../enrollment-form-admin";
import { type EnrollmentField } from "@sunpride/customer-master";
const key = (n: number) => `cf_${String(n).padStart(32, "0")}`;
const fields: EnrollmentField[] = [
  "text",
  "number",
  "date",
  "choice",
  "boolean",
  "photo",
].map((kind, i) => ({
  key: key(i),
  label: `Sample ${kind}`,
  kind,
  choices: kind === "choice" ? ["Red", "Blue"] : [],
  requiredChannels: ["10"],
  requiredTypes: [],
}));
describe("SP-0229 enrollment form", () => {
  it("renders six controls in office order, required only for chosen channels, with explicit No", () => {
    const render = (channel: string) =>
      renderToStaticMarkup(
        <EnrollmentFields
          fields={fields}
          values={{ [key(4)]: "false" }}
          customer={{ distributionChannelCode: channel }}
          onChange={() => undefined}
        />,
      );
    const required = render("10");
    expect(required).toContain('type="number"');
    expect(required).toContain('type="date"');
    expect(required).toContain('type="file"');
    expect(required).toContain('accept="image/jpeg"');
    expect(required).toContain('value="false" selected=""');
    expect(required).toContain("Sample text *");
    expect(render("41")).toContain("Sample text (optional)");
    expect(reorderEnrollment(fields, 5, 0).map((f) => f.key)).toEqual([
      key(5),
      key(0),
      key(1),
      key(2),
      key(3),
      key(4),
    ]);
  });
  it("preserves answers through customer restore, edits and payload; checks the selected customer", () => {
    const draft = {
      ...emptyDraft(),
      enrollmentFields: fields,
      customFields: { [key(0)]: "Cash desk", [key(1)]: "0", [key(4)]: "false" },
    };
    expect(toPayload(draft).customFields).toEqual(draft.customFields);
    const restored = draftFromCustomer({
      id: "sample",
      code: "SAMPLE",
      customFields: draft.customFields,
    } as unknown as Customer);
    expect(toPayload(restored).customFields).toEqual(draft.customFields);
    const errors = checkDraft(
      indexReference([]),
      { ...draft, values: { ...draft.values, distributionChannelCode: "10" } },
      "complete",
    );
    expect(errors[`customFields.${key(2)}`]).toContain("required");
    expect(errors[`customFields.${key(4)}`]).toBeUndefined();
    const optional = checkDraft(
      indexReference([]),
      { ...emptyDraft(), enrollmentFields: fields },
      "complete",
    );
    expect(
      Object.keys(optional).filter((k) => k.startsWith("customFields.")),
    ).toEqual([]);
  });
});
