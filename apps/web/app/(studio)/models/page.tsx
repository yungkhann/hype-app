import type { Metadata } from "next";
import { ModelsView } from "./models-view";

export const metadata: Metadata = { title: "Model Lab" };

export default function Page() {
  return <ModelsView />;
}
