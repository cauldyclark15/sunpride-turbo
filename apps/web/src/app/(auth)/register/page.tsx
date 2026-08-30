import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthScreen } from "@/components/auth-screen";
import { safeAuthDestination } from "@/lib/auth-routing";
import { isAuthenticated } from "@/lib/auth-server";

export const metadata: Metadata = { title: "Register" };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  if (await isAuthenticated()) redirect(safeAuthDestination(next));
  return <AuthScreen mode="register" next={next} />;
}
