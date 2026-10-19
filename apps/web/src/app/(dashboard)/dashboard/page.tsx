import { redirect } from "next/navigation";

/** The old Home is now Today. */
export default function DashboardRedirect() {
  redirect("/today");
}
