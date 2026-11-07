import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page";
import { EvaluationsView } from "./evaluations-view";

export const metadata: Metadata = { title: "Evaluations" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <EvaluationsView />
    </Suspense>
  );
}
