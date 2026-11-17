import type { Metadata } from "next";
import { ResetPasswordScreen } from "@/components/auth/password-reset-screens";

export const metadata: Metadata = {
  title: "Choose a new password",
  // The link carries a one-time token: never send it on to other sites.
  referrer: "no-referrer",
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  return <ResetPasswordScreen token={typeof token === "string" ? token : ""} />;
}
