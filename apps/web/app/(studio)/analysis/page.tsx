import type { Metadata } from "next";
import { AnalysisView } from "./analysis-view";

export const metadata: Metadata = { title: "Analysis Lab" };

export default function Page() {
  return <AnalysisView />;
}
