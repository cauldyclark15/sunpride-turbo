import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthScreen } from "@/components/auth-screen";
import { safeAuthDestination } from "@/lib/auth-routing";
import { isAuthenticated } from "@/lib/auth-server";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reset?: string }>;
}) {
  const { next, reset } = await searchParams;
  if (await isAuthenticated()) redirect(safeAuthDestination(next));
  return (
    <AuthScreen
      mode="login"
      next={next}
      notice={
        reset === "done"
          ? "Your password was changed. Sign in with your new password."
          : undefined
      }
    />
  );
}
