import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page";
import { OverviewView } from "./overview-view";

export const metadata: Metadata = { title: "Overview" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <OverviewView />
    </Suspense>
  );
}
