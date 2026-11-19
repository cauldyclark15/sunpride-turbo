import type { Metadata } from "next";
import { PrivacyPolicy } from "@/components/privacy/privacy-policy";

export const metadata: Metadata = { title: "Privacy policy" };

/** Public on purpose (SP-0208): Google Play links here; no sign-in needed. */
export default function PrivacyPage() {
  return <PrivacyPolicy />;
}
