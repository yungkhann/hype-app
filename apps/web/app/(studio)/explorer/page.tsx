import type { Metadata } from "next";
import { ExplorerView } from "./explorer-view";

export const metadata: Metadata = { title: "Explorer" };

export default function Page() {
  return <ExplorerView />;
}
