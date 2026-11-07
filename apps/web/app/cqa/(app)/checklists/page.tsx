import type { Metadata } from "next";
import { ChecklistsView } from "./checklists-view";

export const metadata: Metadata = { title: "Checklists" };

export default function Page() {
  return <ChecklistsView />;
}
