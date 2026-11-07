import type { Metadata } from "next";
import { PrepareView } from "./prepare-view";

export const metadata: Metadata = { title: "Prepare" };

export default function Page() {
  return <PrepareView />;
}
