import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CustomerEditor, CustomerEditorView } from "./customer-editor";
import { emptyDraft, toPayload, type Customer, type Draft } from "./model";

type ViewProps = Parameters<typeof CustomerEditorView>[0];
const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  customer: null as Customer | null,
  view: null as ViewProps | null,
  mutate: vi.fn(),
}));

// Retain local state across explicit SSR renders and invoke the actual editor callbacks.
// Lists, permissions and transport are fixtures; validation and field markup are real.
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = state.cursor++;
      if (!(index in state.values))
        state.values[index] =
          typeof initial === "function" ? initial() : initial;
      return [
        state.values[index],
        (next: unknown) => {
          state.values[index] =
            typeof next === "function" ? next(state.values[index]) : next;
        },
      ];
    },
  };
});
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ can: () => true }),
  useSession: () => ({ profile: { id: "office-person" } }),
}));
vi.mock("../../lib/api", () => ({
  mutate: (...args: unknown[]) => state.mutate(...args),
  apiFetch: vi.fn(),
  useApi: (key: string[] | null) => ({
    data: !key
      ? undefined
      : key[1] === "reference"
        ? { lists: { sample: lists } }
        : key?.[1] === "one"
          ? state.customer
          : key?.[1] === "store-setup"
            ? {
                units: [{ id: "area", name: "Sample area" }],
                defaultUnitId: "area",
              }
            : { options: [] },
  }),
}));
function capture(type: unknown, props: Record<string, unknown>) {
  if (type === CustomerEditorView) state.view = props as ViewProps;
}
vi.mock("react/jsx-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  const wrap =
    (fn: typeof actual.jsx) =>
    (type: React.ElementType, props: Record<string, unknown>, key: string) => {
      capture(type, props);
      return fn(type, props, key);
    };
  return { ...actual, jsx: wrap(actual.jsx), jsxs: wrap(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      capture(args[0], args[1] as Record<string, unknown>);
      return actual.jsxDEV(...args);
    },
  };
});

const lists = [
  ["country", "PH"],
  ["tax_classification", "1"],
  ["sales_organization", "1000"],
  ["customer_group", "74"],
  ["type_of_business", "Sole Proprietor"],
  ["payment_terms", "0003"],
  ["pricing_procedure", "2"],
].map(([list, code]) => ({ list, code, name: code, active: true }));
for (const [list, code] of [
  ["sales_office", "100"],
  ["distribution_channel", "50"], // No conditional customer groups or ADP fields.
  ["delivering_plant", "1000"],
])
  lists.push({
    list,
    code,
    name: code,
    active: true,
    salesOrgCode: "1000",
  } as (typeof lists)[number]);

function complete(): Draft {
  const draft = emptyDraft();
  Object.assign(draft.values, {
    registeredName: "Sample Registered Name",
    customerName: "Sample Customer",
    customerAddress: "Sample Address",
    mobileNo: "09171234567",
    taxClassificationCode: "1",
    regionCode: "0700000000",
    provinceCode: "0702200000",
    municipalityCode: "0730600000",
    barangayCode: "0730600003",
    postalCode: "6000",
    salesOrgCode: "1000",
    salesOfficeCode: "100",
    distributionChannelCode: "50",
    customerGroupCode: "74",
    typeOfBusiness: "Sole Proprietor",
    paymentTermsCode: "0003",
    pricingProcedureCode: "2",
    deliveringPlantCode: "1000",
  });
  draft.addressCustom = true;
  draft.latitude = "10.3312";
  draft.longitude = "123.9056";
  draft.shipTos[0]!.contactPerson = "Sample Contact";
  return draft;
}
function customer(
  draft: Draft,
  status: "prospect" | "active" = "prospect",
): Customer {
  return {
    ...toPayload(draft),
    id: "customer",
    code: "SAMPLE-213",
    status,
    completeness: "complete",
    enrolmentStatus: null,
    addressCustom: true,
    pinStatus: "pending",
    custodianOrgUnitId: "area",
  } as Customer;
}
function render() {
  state.cursor = 0;
  return renderToStaticMarkup(
    createElement(CustomerEditor, {
      customerId: state.customer?.id,
    }),
  );
}
function view() {
  expect(state.view).not.toBeNull();
  return state.view!;
}
beforeEach(() => {
  state.values = [];
  state.customer = null;
  state.view = null;
  state.mutate.mockReset().mockResolvedValue(customer(complete()));
});

describe("SP-0213 customer Save required fields", () => {
  it("blocks a name-only new customer and shows required messages without sending a request", async () => {
    render();
    const draft = emptyDraft();
    draft.values.customerName = "Sample Customer";
    view().onChange(draft);
    render();
    await view().onSave?.();
    const html = render();
    expect(state.mutate).not.toHaveBeenCalled();
    for (const message of [
      "Registered Name is required.",
      "Terms of payment is required.",
      "Geographical Coordinates is required.",
      "Contact Person is required.",
    ])
      expect(html).toContain(message);
    expect(html).toContain('aria-invalid="true"');
  });

  it.each(["prospect", "active"] as const)(
    "blocks clearing required fields on an existing %s",
    async (status) => {
      state.customer = customer(complete(), status);
      render();
      const draft = complete();
      draft.values.registeredName = "  ";
      draft.values.paymentTermsCode = "";
      view().onChange(draft);
      render();
      await view().onSave?.();
      render();
      expect(state.mutate).not.toHaveBeenCalled();
      expect(view().errors.registeredName).toBe("Registered Name is required.");
      expect(view().errors.paymentTermsCode).toBe(
        "Terms of payment is required.",
      );
      // Fixing just one highlighted field must not clear the other missing field.
      draft.values.registeredName = "Sample Registered Name";
      view().onChange({ ...draft, values: { ...draft.values } });
      render();
      expect(view().errors.registeredName).toBeUndefined();
      expect(view().errors.paymentTermsCode).toBe(
        "Terms of payment is required.",
      );
      await view().onSave?.();
      expect(state.mutate).not.toHaveBeenCalled();
    },
  );

  it("saves once all required fields are filled while optional fields stay empty", async () => {
    render();
    view().onChange(complete());
    render();
    await view().onSave?.();
    const html = render();
    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(state.mutate.mock.calls[0]![0]).toBe("/api/v1/customers");
    expect(state.mutate.mock.calls[0]![1].customer).toMatchObject({
      registeredName: "Sample Registered Name",
      email: null,
      creditLimit: null,
    });
    expect(html).toContain("created as a prospect.");
    expect(view().errors).toEqual({});
  });
});
