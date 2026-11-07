import type { Metadata } from "next";
import { ChallengeView } from "./challenge-view";

export const metadata: Metadata = { title: "Challenge" };

export default function Page() {
  return <ChallengeView />;
}
