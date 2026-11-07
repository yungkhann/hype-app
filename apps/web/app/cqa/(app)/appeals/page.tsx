import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page";
import { AppealsView } from "./appeals-view";

export const metadata: Metadata = { title: "Appeals" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AppealsView />
    </Suspense>
  );
}
