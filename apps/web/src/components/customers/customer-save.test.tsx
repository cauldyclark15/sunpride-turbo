import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CustomerEditor, CustomerEditorView } from "./customer-editor";
import {
  emptyDraft,
  setField,
  toPayload,
  type Customer,
  type Draft,
} from "./model";

type ViewProps = Parameters<typeof CustomerEditorView>[0];
const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  customer: null as Customer | null,
  permissions: null as string[] | null,
  view: null as ViewProps | null,
  inputs: new Map<string, Record<string, unknown>>(),
  mutate: vi.fn(),
  postalOptions: [] as { code: string; name: string; area?: string }[],
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
    useRef: (initial: unknown) => {
      const index = state.cursor++;
      if (!(index in state.values)) state.values[index] = { current: initial };
      return state.values[index];
    },
  };
});
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({
    can: (capability: string) =>
      state.permissions === null || state.permissions.includes(capability),
  }),
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
            : key[2] === "postal-codes"
              ? { options: state.postalOptions }
              : key[2] === "barangays"
                ? { options: [{ code: "0730600003", name: "Apas" }] }
                : { options: [] },
  }),
}));
function capture(type: unknown, props: Record<string, unknown>) {
  if (type === CustomerEditorView) state.view = props as ViewProps;
  if ((type === "input" || type === "select") && typeof props.id === "string")
    state.inputs.set(props.id, props);
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
    firstName: "Sample",
    lastName: "Customer",
    customerAddress: "Sample Address",
    mobileNo: "09171234567",
    taxClassificationCode: "1",
    regionCode: "0700000000",
    provinceCode: "0702200000",
    municipalityCode: "0730600000",
    barangayCode: "0730600003",
    street1: "Gorordo Ave",
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
  state.permissions = null;
  state.view = null;
  state.inputs.clear();
  state.postalOptions = [];
  state.mutate.mockReset().mockResolvedValue(customer(complete()));
});

it("SP-0250 the submitting salesman and CDM can save partial details while approval stays pending", async () => {
  state.permissions = [];
  state.customer = {
    ...customer(complete()),
    canEdit: true,
    enrolmentStatus: "provisional",
    updatedAt: 123,
  };
  const edited = setField(complete(), "registeredName", "");
  const saved = {
    ...state.customer,
    registeredName: null,
    completeness: "draft",
    updatedAt: 124,
  };
  state.mutate.mockResolvedValue(saved);
  render();
  view().onChange(edited);
  render();
  expect(view().readOnly).toBe(false);
  await view().onSave?.();
  const html = render();
  expect(state.mutate).toHaveBeenCalledWith(
    "/api/v1/customers/customer",
    expect.objectContaining({
      expectedUpdatedAt: 123,
      customer: expect.objectContaining({ registeredName: null }),
    }),
    expect.objectContaining({ method: "PUT" }),
  );
  expect(html).toContain("Still waiting for approval");
  expect(view().errors.registeredName).toContain("required");
});

it("SP-0250 a newer read-only permission withdraws editing from an already open form", async () => {
  state.permissions = [];
  state.customer = {
    ...customer(complete()),
    canEdit: true,
    enrolmentStatus: "provisional",
  };
  render();
  expect(view().readOnly).toBe(false);
  state.customer = {
    ...state.customer,
    status: "active",
    enrolmentStatus: "approved",
    canEdit: false,
  };
  render();
  expect(view().readOnly).toBe(true);
  await view().onSave?.();
  expect(state.mutate).not.toHaveBeenCalled();
});

it("SP-0250 an approved profile is read-only even for a general store editor", async () => {
  state.permissions = ["outlet.manage"];
  state.customer = {
    ...customer(complete(), "active"),
    enrolmentStatus: "approved",
    canEdit: false,
  };
  const html = render();
  expect(view().readOnly).toBe(true);
  expect(html).toContain("Read only");
  await view().onSave?.();
  expect(state.mutate).not.toHaveBeenCalled();
});

it("SP-0250 approval immediately retires the CDM's editing controls and keeps readable history", async () => {
  state.customer = { ...customer(complete()), canEdit: true };
  state.mutate.mockResolvedValue({
    ...state.customer,
    status: "active",
    enrolmentStatus: "approved",
    canEdit: false,
    history: [
      {
        id: "change",
        actor: "Sample salesman",
        at: 123,
        changes: [
          {
            field: "street1",
            label: "Street 1",
            before: null,
            after: "Sample Road",
          },
        ],
      },
    ],
  });
  render();
  await view().onApprove?.();
  const html = render();
  expect(view().readOnly).toBe(true);
  expect(html).toContain("Change history");
  expect(html).toContain("Sample salesman");
  expect(html).toContain("Street 1: Not set → Sample Road");
});

it("SP-0243 the office sees Location not confirmed when a customer was saved without a pin", () => {
  state.customer = {
    ...customer(complete()),
    latitude: null,
    longitude: null,
    pinStatus: null,
  };
  const html = render();
  expect(html).toContain("Location not confirmed");
  expect(html).not.toContain("Pin verified");
  state.permissions = [];
  expect(render()).toContain("Location not confirmed");
});

it("SP-0246 choosing a barangay fills its ZIP; a manual entry or clearing survives save", async () => {
  state.postalOptions = [
    { code: "6000", name: "6000 Apas", area: "Apas" },
    { code: "6001", name: "6001 Other", area: "Other" },
  ];
  render();
  view().onChange(setField(complete(), "barangayCode", ""));
  render();
  // Enter through the actual Barangay select, not a synthetic filled draft.
  (state.inputs.get("cm-barangayCode")!.onChange as (e: unknown) => void)({
    target: { value: "0730600003" },
  });
  render();
  expect(view().draft.values.postalCode).toBe("6000");
  // A town with just one ZIP fills it even without an area label.
  state.postalOptions = [{ code: "6000", name: "6000" }];
  view().onChange(setField(view().draft, "barangayCode", ""));
  render();
  (state.inputs.get("cm-barangayCode")!.onChange as (e: unknown) => void)({
    target: { value: "0730600003" },
  });
  render();
  expect(view().draft.values.postalCode).toBe("6000");
  const type = (value: string) =>
    (state.inputs.get("cm-postalCode")!.onChange as (e: unknown) => void)({
      target: { value },
    });
  type("9999");
  render();
  expect(view().draft.values.postalCode).toBe("9999");
  await view().onSave?.();
  expect(state.mutate.mock.calls.at(-1)?.[1].customer.postalCode).toBe("9999");
  render();
  type("");
  render();
  await view().onSave?.();
  expect(state.mutate.mock.calls.at(-1)?.[1].customer.postalCode).toBeNull();
});

it("SP-0223 Sales Head can set required visits while the rest of the customer stays read-only", () => {
  state.permissions = ["outlet.frequency.manage"];
  state.customer = {
    ...customer(complete(), "active"),
    visitFrequency: "4 times a month",
    visitFrequencyDays: 7,
    visitFrequencyPerMonth: 4,
  };
  const html = render();
  expect(html).toContain("4 visits/month");
  expect(html).toContain("Save visit frequency");
  expect(view().canEdit).toBe(false);
  expect(view().readOnly).toBe(true);
});

it("SP-0223 read-only people cannot change visit frequency on the customer screen", () => {
  state.permissions = [];
  state.customer = {
    ...customer(complete(), "active"),
    visitFrequency: "Monthly",
    visitFrequencyDays: 30,
    visitFrequencyPerMonth: null,
  };
  const html = render();
  expect(html).toContain("1 visit/month");
  expect(html).not.toContain("Save visit frequency");
  expect(view().canEdit).toBe(false);
});

describe("SP-0240 keeps full Customer Name and manual split-name mapping", () => {
  it.each(["new", "prospect", "active"] as const)(
    "keeps a full name editable for a %s customer alongside optional name controls",
    async (status) => {
      if (status !== "new") state.customer = customer(complete(), status);
      const html = render();
      expect(html).toContain('id="cm-customerName"');
      expect(state.inputs.get("cm-customerName")?.["aria-required"]).toBe(true);
      for (const key of ["firstName", "middleName", "lastName"])
        expect(html).toContain(`id="cm-${key}"`);
      view().onChange(complete());
      render();
      const change = (value: string) => {
        (
          state.inputs.get("cm-customerName")!.onChange as (e: {
            target: { value: string };
          }) => void
        )({ target: { value } });
        render();
      };
      view().onChange({
        ...complete(),
        values: {
          ...complete().values,
          firstName: "",
          lastName: "",
          middleName: "",
        },
      });
      render();
      change(" \t ");
      await view().onSave?.();
      render();
      expect(state.mutate).not.toHaveBeenCalled();
      expect(view().errors).toMatchObject({
        firstName: "First Name is required.",
        lastName: "Last Name is required.",
      });
      change("mARÍA jOSÉ de la cruz");
      await view().onSave?.();
      render();
      expect(state.mutate).toHaveBeenCalledTimes(1);
      const saved = state.mutate.mock.calls[0]![1].customer;
      expect(saved.customerName).toBe("María José De La Cruz");
      for (const key of ["firstName", "middleName", "lastName"])
        expect(saved).toHaveProperty(key, null);
    },
  );
  it.each(["admin", "approver"])(
    "lets the %s review and approve a full name without hidden-name requirements",
    async (role) => {
      state.permissions = role === "admin" ? null : ["outlet.enrol.approve"];
      state.customer = {
        ...customer(complete()),
        customerName: "REYES, María José",
        firstName: "María José",
        middleName: null,
        lastName: null,
        canEdit: role === "admin",
        completeness: "draft",
      };
      state.mutate.mockResolvedValue({
        ...state.customer,
        status: "active",
        completeness: "complete",
        missingFields: [],
        fieldMissing: null,
      });
      const html = render();
      expect(html).toContain('id="cm-customerName"');
      expect(html).toContain("Complete. Ready for approval.");
      expect(view().errors).toEqual({});
      expect(state.inputs.get("cm-customerName")?.value).toBe(
        "REYES, María José",
      );
      for (const key of ["firstName", "middleName", "lastName"])
        expect(html).toContain(`id="cm-${key}"`);
      await view().onApprove?.();
      expect(state.mutate).toHaveBeenCalledTimes(1);
      expect(state.mutate.mock.calls[0]?.[0]).toBe(
        "/api/v1/customers/customer/approve",
      );
      expect(render()).toContain("Approved. Customer Code SAMPLE-213.");
      expect(view().draft.values.customerName).toBe("REYES, María José");
    },
  );
  it.each(["admin", "approver"])(
    "lets the %s map optional name parts without changing the saved full name",
    async (role) => {
      state.permissions = role === "admin" ? null : ["outlet.enrol.approve"];
      state.customer = {
        ...customer(complete()),
        customerName: "Doronila, Ruchie",
        firstName: null,
        middleName: null,
        lastName: null,
        canEdit: true,
      };
      render();
      expect(view().errors).toEqual({});
      for (const key of ["firstName", "middleName", "lastName"])
        expect(
          state.inputs.get(`cm-${key}`)?.["aria-required"],
        ).toBeUndefined();
      const change = (key: string, value: string) => {
        (
          state.inputs.get(`cm-${key}`)!.onChange as (e: {
            target: { value: string };
          }) => void
        )({ target: { value } });
        render();
      };
      change("firstName", "Ruchie");
      expect(view().draft.values.customerName).toBe("Doronila, Ruchie");
      await view().onSave?.();
      expect(state.mutate.mock.calls[0]?.[1].customer).toMatchObject({
        customerName: "Doronila, Ruchie",
        firstName: "Ruchie",
        middleName: null,
        lastName: null,
      });
    },
  );
  it.each([
    {
      firstName: "María José",
      middleName: "Peña",
      lastName: "O’Neil",
      customerName: "María José Peña O’Neil",
    },
    {
      firstName: null,
      middleName: null,
      lastName: null,
      customerName: "CRUZ, María José",
    },
  ])(
    "reopens existing names intact and lets the full name be edited",
    async (names) => {
      state.customer = { ...customer(complete()), ...names };
      expect(render()).not.toContain("Previous Customer Name");
      expect(view().draft.values.customerName).toBe(names.customerName);
      (
        state.inputs.get("cm-customerName")!.onChange as (e: {
          target: { value: string };
        }) => void
      )({ target: { value: "Ana Reyes" } });
      render();
      await view().onSave?.();
      expect(state.mutate.mock.calls[0]![1].customer).toMatchObject({
        customerName: "Ana Reyes",
        shipTos: [expect.objectContaining({ shipToParty: "Ana Reyes" })],
      });
    },
  );
});

describe("SP-0255 optional Street 1 on customer enrollment", () => {
  it.each(["new", "prospect", "active"] as const)(
    "saves a %s customer without Street 1 and keeps the coordinates",
    async (status) => {
      if (status !== "new") state.customer = customer(complete(), status);
      const initial = render();
      expect(initial).toMatch(
        /<label[^>]*for="cm-street1"[^>]*>Street 1<\/label>/,
      );
      expect(state.inputs.get("cm-street1")?.required).not.toBe(true);
      expect(state.inputs.get("cm-street1")?.["aria-required"]).toBeUndefined();
      expect(state.inputs.get("cm-street1")?.placeholder).toBe("Optional");
      state.mutate.mockImplementation(async (_path, body) => ({
        ...customer(complete(), status === "active" ? "active" : "prospect"),
        ...body.customer,
      }));
      for (const blank of [undefined, "", " \t "]) {
        const draft = complete();
        if (blank === undefined) delete draft.values.street1;
        else draft.values.street1 = blank;
        view().onChange(draft);
        render();
        await view().onSave?.();
        const html = render();
        expect(view().errors).toEqual({});
        expect(html).not.toContain('aria-describedby="cm-street1-error"');
        expect(html).toMatch(/Saved\.|created as a prospect\./);
        expect(state.mutate.mock.calls.at(-1)![1].customer).toMatchObject({
          street1: null,
          latitude: 10.3312,
          longitude: 123.9056,
        });
        expect(view().draft.values.street1).toBe("");
      }
      expect(state.mutate).toHaveBeenCalledTimes(3);
      view().onChange(setField(complete(), "street1", "  Gorordo Ave  "));
      render();
      await view().onSave?.();
      expect(state.mutate.mock.calls.at(-1)![1].customer.street1).toBe(
        "Gorordo Ave",
      );
    },
  );

  it.each(["prospect", "active"] as const)(
    "lets an office administrator clear Street 1 and reopen a %s without weakening coordinates",
    async (status) => {
      state.permissions = ["outlet.manage"];
      state.customer = { ...customer(complete(), status), canEdit: true };
      // Fixture transport only: persist the real editor payload for a fresh form render.
      state.mutate.mockImplementation(async (_path, body) => {
        state.customer = { ...state.customer!, ...body.customer };
        return state.customer;
      });
      render();
      expect(view().readOnly).toBe(false);
      const street = state.inputs.get("cm-street1")!;
      (street.onChange as (e: { target: { value: string } }) => void)({
        target: { value: "" },
      });
      render();
      await view().onSave?.();
      expect(state.mutate).toHaveBeenCalledTimes(1);
      expect(state.mutate.mock.calls[0]![1].customer).toMatchObject({
        street1: null,
        latitude: 10.3312,
        longitude: 123.9056,
      });

      state.values = [];
      const reopened = render();
      expect(view().draft.values.street1).toBe("");
      expect(view().errors).toEqual({});
      expect(reopened).toContain("All required fields filled");
      expect(reopened).not.toContain('id="cm-street1-error"');
      expect(state.inputs.get("cm-street1")?.placeholder).toBe("Optional");

      view().onChange({ ...view().draft, latitude: "", longitude: "" });
      render();
      await view().onSave?.();
      render();
      expect(state.mutate).toHaveBeenCalledTimes(1);
      expect(view().errors).toEqual({
        coordinates: "Geographical Coordinates is required.",
      });
    },
  );
});

describe("SP-0220 address edits", () => {
  it.each(["prospect", "active"] as const)(
    "saves normal punctuation when editing a %s; no separate Customer Address field (SP-0220)",
    async (status) => {
      state.customer = customer(complete(), status);
      state.mutate.mockImplementation(async (_path, body) => ({
        ...state.customer,
        ...body.customer,
      }));
      for (const address of [
        "Blk 5, Lot 3. Brgy. Guadalupe",
        "#5-A / Lot 3. Brgy. Guadalupe, Cebu",
      ]) {
        render();
        const draft = setField(view().draft, "street1", address);
        view().onChange(draft);
        const edited = render();
        expect(edited).not.toContain('id="cm-customerAddress"');
        expect(edited).not.toContain("Customer Address");
        for (const key of ["street1"]) {
          const input = edited.match(
            new RegExp(`<input[^>]*id="cm-${key}"[^>]*>`),
          )?.[0];
          expect(input).toContain(`value="${address}"`);
          expect(input).not.toContain("pattern=");
        }
        await view().onSave?.();
        const saved = render();
        expect(view().errors).toEqual({});
        expect(saved).toContain("Saved.");
        const [path, body, options] = state.mutate.mock.calls.at(-1)!;
        expect(path).toBe("/api/v1/customers/customer");
        expect(options.method).toBe("PUT");
        expect(body.customer).toMatchObject({ street1: address });
        expect(body.customer).not.toHaveProperty("customerAddress");
        expect(body.customer.shipTos[0].shipToAddress).toContain(address);
        expect(view().draft.values.street1).toBe(address);
      }
      expect(state.mutate).toHaveBeenCalledTimes(2);
    },
  );
});

describe("SP-0213 customer Save required fields", () => {
  it.each(["new", "prospect", "active"] as const)(
    "does not keep a saved notice after Registered Name is cleared on a %s customer",
    async (status) => {
      if (status !== "new") state.customer = customer(complete(), status);
      render();
      if (status === "new") {
        view().onChange(complete());
        render();
      }
      await view().onSave?.();
      render();
      expect(view().message?.tone).toBe("ok");
      expect(state.mutate).toHaveBeenCalledTimes(1);

      // Use a still-required control, not an independently constructed draft.
      const changeName = (value: string) => {
        const input = state.inputs.get("cm-registeredName")!;
        (input.onChange as (e: { target: { value: string } }) => void)({
          target: { value },
        });
        return render();
      };
      const changed = changeName("");
      expect(view().message?.tone).not.toBe("ok");
      expect(changed).toContain("Unsaved changes");
      expect(changed).not.toContain("All required fields filled");
      expect(view().draft.values.registeredName).toBe("");
      await view().onSave?.();
      const refused = render();
      expect(state.mutate).toHaveBeenCalledTimes(1);
      expect(view().errors).toEqual({
        registeredName: "Registered Name is required.",
      });
      expect(refused).toContain("Registered Name is required.");
      expect(refused).not.toContain("Saved.");
      expect(refused).not.toContain("All required fields filled");
      expect(refused).toContain("Unsaved changes");
      expect(view().draft.values.registeredName).toBe("");
      if (status !== "active") {
        await view().onApprove?.();
        render();
        expect(state.mutate).toHaveBeenCalledTimes(1);
        expect(view().errors.registeredName).toBe(
          "Registered Name is required.",
        );
      }

      changeName("New Sample Store");
      expect(view().errors.registeredName).toBeUndefined();
      await view().onSave?.();
      render();
      expect(state.mutate).toHaveBeenCalledTimes(2);
      expect(state.mutate.mock.calls[1]![1].customer.registeredName).toBe(
        "New Sample Store",
      );
      expect(view().message?.tone).toBe("ok");
      expect(view().hasUnsavedChanges).toBe(false);
      expect(render()).toContain("All required fields filled");
    },
  );

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

describe("SP-0239 automatic Customer Code", () => {
  it.each(["new", "prospect", "active"] as const)(
    "shows a read-only number and omits typed values from %s save requests",
    async (status) => {
      if (status !== "new") state.customer = customer(complete(), status);
      const initial = render();
      expect(state.inputs.get("cm-code")?.readOnly).toBe(true);
      expect(state.inputs.get("cm-code")?.onChange).toBeUndefined();
      expect(initial).toContain("Assigned automatically.");
      const draft = complete();
      draft.code = "TYPED-BY-OLD-FORM";
      view().onChange(draft);
      render();
      const saved = {
        ...customer(complete(), status === "active" ? "active" : "prospect"),
        code: "SP000239",
      };
      state.mutate.mockResolvedValueOnce(saved);
      await view().onSave?.();
      const html = render();
      expect(state.mutate).toHaveBeenCalledTimes(1);
      const [path, body] = state.mutate.mock.calls[0]!;
      expect(path).toBe(
        status === "new" ? "/api/v1/customers" : "/api/v1/customers/customer",
      );
      expect(body).not.toHaveProperty("code");
      expect(body.customer).not.toHaveProperty("code");
      expect(state.inputs.get("cm-code")?.value).toBe("SP000239");
      expect(html).toContain("SP000239");
    },
  );
});

it("a second save of the same open customer uses a new request key, so it is never refused as different details", async () => {
  state.customer = { ...customer(complete()), canEdit: true, updatedAt: 123 };
  state.mutate.mockImplementation(async (_url: string, body: { expectedUpdatedAt?: number }) => ({
    ...state.customer!,
    updatedAt: (body.expectedUpdatedAt ?? 0) + 1,
  }));
  render();
  view().onChange(setField(complete(), "tradeName", "First"));
  render();
  await view().onSave?.();
  render();
  await view().onSave?.();
  const keys = state.mutate.mock.calls.map((call) => (call[2] as { idempotencyKey: string }).idempotencyKey);
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
});
