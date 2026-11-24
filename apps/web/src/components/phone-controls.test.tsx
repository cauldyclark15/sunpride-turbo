import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { PhoneControls, PersonPhoneActions, phoneControlsHref, type PhoneControlData } from "./phone-controls";
const state = vi.hoisted(() => ({ data: undefined as PhoneControlData | undefined, cursor: 0, values: [] as unknown[], buttons: {} as Record<string, () => Promise<void>>, mutate: vi.fn(), confirm: vi.fn() }));
vi.mock("../lib/api", () => ({ useApi: () => ({ data: state.data, refetch: vi.fn() }), mutate: (...args: unknown[]) => state.mutate(...args) }));
vi.mock("react", async original => ({ ...(await original<typeof import("react")>()), useState: (initial: unknown) => {
  const i = state.cursor++; if (!(i in state.values)) state.values[i] = initial;
  return [state.values[i], (value: unknown) => { state.values[i] = typeof value === "function" ? value(state.values[i]) : value; }];
} }));
function record(type: unknown, props: Record<string, unknown>) {
  if (type === "button" && typeof props.children === "string") state.buttons[props.children] = props.onClick as () => Promise<void>;
}
vi.mock("react/jsx-runtime", async original => { const actual = await original<typeof import("react/jsx-runtime")>(); return { ...actual,
  jsx: (type: React.ElementType, props: Record<string, unknown>, key: string) => { record(type, props); return actual.jsx(type, props, key); },
  jsxs: (type: React.ElementType, props: Record<string, unknown>, key: string) => { record(type, props); return actual.jsxs(type, props, key); },
}; });
vi.mock("react/jsx-dev-runtime", async original => { const actual = await original<typeof import("react/jsx-dev-runtime")>(); return {...actual,
  jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => { record(args[0], args[1] as Record<string, unknown>); return actual.jsxDEV(...args); },
}; });
function render() { state.cursor=0; state.buttons={}; return renderToStaticMarkup(createElement(PhoneControls,{profileId:"person"})); }
beforeEach(() => {
  state.values=[]; state.confirm.mockReset().mockReturnValue(true); state.mutate.mockReset().mockResolvedValue({count:2});
  vi.stubGlobal("window",{confirm:state.confirm});
  state.data={person:{id:"person",name:"Sample Person",autoAccept:false},more:false,phones:[{
    id:"phone",deviceId:"phone",requestId:null,app:"field-android",label:"Phone",model:"Sample model",appVersion:"1.0-sample",status:"registered",signedIn:true,
    unsentCount:3,lastSeenAt:"2026-11-24T01:00:00Z",historyMore:false,history:[{id:"request",kind:"refresh",who:"Sample Operations",requestedAt:"2026-11-24T01:01:00Z",doneAt:null}],
  }]};
});
it("shows actual phone facts, unknown counts, waiting and completed history with the office actor",()=>{
  let html=render(); for(const text of ["Sample Person","Sample model","1.0-sample","Signed in","Unsent items","Sample Operations","Waiting for the phone"]) expect(html).toContain(text);
  state.data!.phones[0]!.history[0]!.doneAt="2026-11-24T01:02:00Z"; state.data!.phones[0]!.unsentCount=null;
  html=render();expect(html).toContain("Done at");expect(html).toContain("Not reported yet");
});
it("confirms every phone action, posts the exact target, and does nothing after cancel",async()=>{
  for(const [label,action] of [["Sign out phone","sign_out"],["Refresh phone","refresh"],["Send unsent work now","resend"],["Remove phone","remove"],["Ask to update","update"]]) {
    render(); await state.buttons[label]!();
    expect(state.confirm).toHaveBeenCalled();
    expect(state.mutate).toHaveBeenLastCalledWith("/api/v1/people/phone-controls",{profileId:"person",action,deviceId:"phone"},expect.objectContaining({idempotencyKey:expect.any(String)}));
  }
  state.mutate.mockClear();state.confirm.mockReturnValue(false);render();await state.buttons["Sign out phone"]!();expect(state.mutate).not.toHaveBeenCalled();
});
it("registers a waiting replacement and confirms auto-accept for just this person",async()=>{
  state.data!.phones[0]!.requestId="waiting";state.data!.phones[0]!.deviceId=null;state.data!.phones[0]!.status="waiting";
  render();await state.buttons["Register / Replace phone"]!();expect(state.mutate).toHaveBeenLastCalledWith(expect.any(String),{profileId:"person",action:"register",requestId:"waiting"},expect.anything());
  render();await state.buttons["Turn auto-accept on"]!();expect(state.mutate).toHaveBeenLastCalledWith(expect.any(String),{profileId:"person",action:"auto_accept",enabled:true},expect.anything());
});
it("offers a direct People link and sign-out-all with a short confirmation",async()=>{
  state.cursor=0;const html=renderToStaticMarkup(createElement(PersonPhoneActions,{profileId:"person",name:"Sample Person"}));
  expect(html).toContain("section=devices&amp;phonePerson=person#phone-controls");expect(phoneControlsHref("a b")).toContain("a%20b");
  await state.buttons["Sign out all phones"]!();expect(state.mutate).toHaveBeenCalledWith(expect.any(String),{profileId:"person",action:"sign_out_all"},expect.anything());
});
it("keeps removed phones read-only and discloses bounded phone/history lists",()=>{
  state.data!.phones[0]!.status="removed";state.data!.phones[0]!.historyMore=true;state.data!.more=true;
  const html=render();expect(html).toContain("latest 100 phones");expect(html).toContain("latest 50 requests");expect(state.buttons["Remove phone"]).toBeUndefined();
});
