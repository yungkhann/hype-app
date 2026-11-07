import type { Metadata } from "next";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page";
import { ConversationView } from "./conversation-view";

export const metadata: Metadata = { title: "Conversation" };

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ConversationView params={params} />
    </Suspense>
  );
}
