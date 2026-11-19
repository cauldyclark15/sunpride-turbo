import { describe, expect, it } from "vitest";
import {
  invitationEmailLabel,
  invitationEmailNotice,
} from "./invitation-email";
import { FIELD_APP_LINKS } from "../../config/app-links";
import { readFileSync } from "node:fs";

describe("SP-0206 invitation delivery wording", () => {
  it("distinguishes provider acceptance from a failed send and local-only preview", () => {
    expect(invitationEmailLabel("accepted")).toBe("Email accepted for sending");
    expect(invitationEmailLabel("failed")).toBe("Email could not be sent");
    expect(invitationEmailLabel("dev_sink")).toBe(
      "Email not sent (local preview)",
    );
    expect(invitationEmailLabel()).toBe("Not emailed yet");
    expect(invitationEmailNotice("accepted")).toContain("Spam folder");
    expect(invitationEmailNotice("failed")).toContain("Resend email");
    expect(invitationEmailNotice("dev_sink")).toContain("No email was sent");
  });
  it("keeps invitation download destinations identical to Share the Field app", () => {
    const mail = readFileSync(
      new URL(
        "../../../../api/src/domains/org/invitation-email.js",
        import.meta.url,
      ),
      "utf8",
    );
    for (const link of FIELD_APP_LINKS) expect(mail).toContain(link.url);
  });
});
