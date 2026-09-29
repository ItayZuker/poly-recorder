/**
 * RECORDER_ROLE decides whether this process may capture ticks. It is REQUIRED:
 * an unset or misspelled value refuses to start (see server.ts), so a checkout
 * that forgot to set it can never silently become a second live recorder.
 *
 * - `recorder`: the one live instance — captures whenever Mongo says Recording is
 *   on, runs retention, backfills local headers to Mongo.
 * - `viewer`: read-only. Never records, never writes shared Mongo state, and the
 *   Recording toggle is disabled. Use this on any machine other than the live
 *   server; two recorders fight over the same `recorded_windows` headers.
 */
export type RecorderRole = "recorder" | "viewer";

export const RECORDER_ROLES: readonly RecorderRole[] = ["recorder", "viewer"];

function rawRole(): string {
  return (process.env.RECORDER_ROLE ?? "").trim().toLowerCase();
}

/** True only when RECORDER_ROLE is set to a known role. */
export function isRecorderRoleValid(): boolean {
  return (RECORDER_ROLES as readonly string[]).includes(rawRole());
}

/** Anything other than an explicit `recorder` is treated as viewer (safe side). */
export function getRecorderRole(): RecorderRole {
  return rawRole() === "recorder" ? "recorder" : "viewer";
}

export function isViewerRole(): boolean {
  return getRecorderRole() === "viewer";
}

/** Only the live recorder captures when Mongo says Recording on. */
export function canProcessRecord(): boolean {
  return getRecorderRole() === "recorder";
}
