import type { InvitationEmailState } from "../master-data/model";

export function invitationEmailLabel(state?: InvitationEmailState): string {
  switch (state) {
    case "accepted":
      return "Email accepted for sending";
    case "failed":
      return "Email could not be sent";
    case "dev_sink":
      return "Email not sent (local preview)";
    default:
      return "Not emailed yet";
  }
}

export function invitationEmailNotice(state: InvitationEmailState): string {
  if (state === "accepted")
    return "Invitation email accepted for sending. Ask them to check their inbox and Spam folder.";
  if (state === "failed")
    return "The invitation email could not be sent. Go to Invited and choose Resend email after one minute.";
  return "No email was sent. Email sending is not enabled here; share the app links and account instructions with the person.";
}
