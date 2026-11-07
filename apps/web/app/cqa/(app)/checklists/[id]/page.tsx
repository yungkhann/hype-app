import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page";
import { ChecklistView } from "./checklist-view";

export const metadata: Metadata = { title: "Checklist" };

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ChecklistView params={params} />
    </Suspense>
  );
}
