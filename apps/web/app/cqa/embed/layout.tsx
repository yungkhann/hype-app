import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: { default: "Conversation quality", template: "%s · CQA" },
  robots: { index: false, follow: false },
};

/**
 * Shell-less CQA views for embedding in a host application (e.g. a Dynamics 365 HTML web resource or iframe).
 * Same components and API calls as the full app; no navigation chrome.
 */
export default function EmbedLayout({ children }: { children: ReactNode }) {
  return <main className="min-h-dvh bg-canvas p-3 sm:p-4">{children}</main>;
}
