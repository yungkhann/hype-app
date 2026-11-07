"use client";

import { use } from "react";
import { ConversationWorkspace } from "@/components/cqa/conversation-workspace";

export function ConversationView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ConversationWorkspace id={decodeURIComponent(id)} />;
}
