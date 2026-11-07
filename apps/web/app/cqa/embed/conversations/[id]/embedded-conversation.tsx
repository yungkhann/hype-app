"use client";

import { use } from "react";
import { ConversationWorkspace } from "@/components/cqa/conversation-workspace";

export function EmbeddedConversation({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ConversationWorkspace id={decodeURIComponent(id)} embedded />;
}
