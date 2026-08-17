export type PracticeSessionStatus = "active" | "completed" | "abandoned";

export type EndPracticeSessionResult =
  | "completed"
  | "already_abandoned"
  | "already_completed";

export function resultForAlreadyEndedSession(
  status: PracticeSessionStatus,
): Exclude<EndPracticeSessionResult, "completed"> | null {
  if (status === "abandoned") return "already_abandoned";
  if (status === "completed") return "already_completed";
  return null;
}
