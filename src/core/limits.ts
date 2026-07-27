/**
 * Policy upper bounds, gathered in one place so a reviewer can see the whole
 * ceiling on agent-supplied text and timing in a single file rather than
 * hunting constants scattered across the orchestrator.
 */

/** Free text Hermes may contribute to a message body, hard-capped. */
export const MAX_HERMES_NOTE_CHARS = 500;
export const MAX_PURPOSE_CHARS = 500;
export const MAX_QUERY_CHARS = 500;
/** An agent-supplied subject line. Single-line by construction, see `clamp`. */
export const MAX_SUBJECT_CHARS = 200;
/** An agent-supplied message body. Generous, because this may be a real letter. */
export const MAX_BODY_CHARS = 10000;
/** What the agent may say it is looking for in a summary. A hint, not a brief. */
export const MAX_FOCUS_CHARS = 300;
/** Absolute schema ceiling; each target may configure a lower limit. */
export const MAX_ATTACHMENTS_PER_ACTION = 50;
/** RFC 5321's own upper bound on a mailbox address. */
export const MAX_RECIPIENT_CHARS = 320;

/** How long `awaitActionDecision` waits by default, and at most. */
export const DEFAULT_DECISION_WAIT_SECONDS = 60;
export const MAX_DECISION_WAIT_SECONDS = 600;
