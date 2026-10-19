import type { Metadata } from "next";
import { AccountPage } from "@/components/account/account-page";

export const metadata: Metadata = { title: "Account" };

// A static route takes precedence over [module]; the dashboard layout requires sign-in.
export default function Page() {
  return <AccountPage />;
}
