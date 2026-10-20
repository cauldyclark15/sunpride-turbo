import { redirect } from "next/navigation";
import { CustomerPortal } from "@/components/modern-trade/portal";
import { serverApi } from "@/lib/api/server";
import { ApiError } from "@/lib/api/errors";
export default async function PortalPage() {
  try {
    await serverApi("/api/v1/portal/session");
  } catch (error) {
    if (error instanceof ApiError && [401, 403].includes(error.status))
      redirect("/portal/login");
    throw error;
  }
  return <CustomerPortal />;
}
