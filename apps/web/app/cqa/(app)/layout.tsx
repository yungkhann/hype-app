import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CqaShell } from "@/components/cqa/cqa-shell";

export const metadata: Metadata = {
  title: { default: "Conversation quality", template: "%s · CQA · ATLAS" },
  description: "Conversation Quality Analytics: import conversations, evaluate them against a versioned checklist, and review appeals.",
};

export default function CqaLayout({ children }: { children: ReactNode }) {
  return <CqaShell>{children}</CqaShell>;
}
