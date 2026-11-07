import type { Metadata } from "next";
import { PresentView } from "./present-view";

export const metadata: Metadata = { title: "Presentation" };

export default function Page() {
  return <PresentView />;
}
