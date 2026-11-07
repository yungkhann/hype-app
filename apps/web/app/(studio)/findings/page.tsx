import type { Metadata } from "next";
import { FindingsView } from "./findings-view";

export const metadata: Metadata = { title: "Findings" };

export default function Page() {
  return <FindingsView />;
}
