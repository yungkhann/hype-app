import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page";
import { ConversationsView } from "./conversations-view";

export const metadata: Metadata = { title: "Conversations" };

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ConversationsView />
    </Suspense>
  );
}
