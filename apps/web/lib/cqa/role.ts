"use client";

import { useStoredJson } from "@/lib/hooks";

/**
 * Demo roles. There is no sign-in: the role only decides which actions the UI offers (operators submit
 * appeals, reviewers decide them) and the name recorded with each action. It is not access control.
 */
export type CqaRole = "operator" | "reviewer";

export type DemoIdentity = { role: CqaRole; operatorName: string; reviewerName: string };

const DEFAULT: DemoIdentity = { role: "operator", operatorName: "Operator", reviewerName: "Reviewer" };

export function useDemoIdentity(): [DemoIdentity, (next: Partial<DemoIdentity>) => void] {
  const [stored, setStored] = useStoredJson<DemoIdentity>("atlas.cqa.identity", DEFAULT);
  const identity: DemoIdentity = {
    role: stored.role === "reviewer" ? "reviewer" : "operator",
    operatorName: stored.operatorName?.trim() || DEFAULT.operatorName,
    reviewerName: stored.reviewerName?.trim() || DEFAULT.reviewerName,
  };
  return [identity, (next) => setStored({ ...identity, ...next })];
}
