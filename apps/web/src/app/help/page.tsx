import type { Metadata } from "next";
import { TesterGuide } from "@/components/beta/tester-guide";
import { betaApkUrl } from "@/config/beta";

export const metadata: Metadata = { title: "Getting started for testers" };

/** Public on purpose: a tester who cannot sign in yet can still read it. */
export default function HelpPage() {
  return <TesterGuide apkUrl={betaApkUrl()} />;
}
