import { redirect } from "next/navigation";

/** The old Reports long scroll is retired; Sales & targets replaces it. */
export default function AnalyticsRedirect() {
  redirect("/sales");
}
