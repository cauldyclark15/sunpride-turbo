import type { Metadata } from "next";
import { DistributorWorkspace } from "../../../components/distributors/workspace";
export const metadata: Metadata = { title: "Distributor portal" };
export default function DistributorPortal() {
  return <DistributorWorkspace portal />;
}
