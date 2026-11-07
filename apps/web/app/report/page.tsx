import type { Metadata } from "next";
import { ReportView } from "./report-view";

export const metadata: Metadata = { title: "Report" };

export default function Page() {
  return <ReportView />;
}
