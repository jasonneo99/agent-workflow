/** One-shot review authority never implies permission to clone or replay it. */
export function automaticRepeatForbidden(run: { workflowId?: string; evaluationMetadata?: Record<string, unknown> | null }): boolean {
  const metadata = run.evaluationMetadata;
  return metadata?.noAutomaticRepeat === true
    || metadata?.kind === "explicit-independent-acceptance-review"
    || metadata?.source === "explicit-independent-acceptance-review"
    || run.workflowId === "explicit-independent-acceptance-review";
}

export const noAutomaticRepeatReason = "Approved action execution is preserved, but this one-shot review cannot be replayed or cloned. The original terminal history remains unchanged; a supported separately authorized same-attempt assessment is required.";

/** Negative intake guard only; never mutate existing runs or reject a direct
 * human's ordinary multi-part product request. Automatic queue recovery must
 * resolve one original outcome, not recursively wrap an entire failed queue.
 */
export function automaticRecoveryWrapperReason(input: { task: string; evaluationMetadata?: Record<string, unknown> }): string | null {
  const source = input.evaluationMetadata?.source;
  if (!['server-orchestration', 'workflow-supervisor-repair', 'blocked-run-repair', 'workflow-root-repair', 'queue-partner-recovery'].includes(String(source))) return null;
  const task = /^(?:workflow-supervisor-repair|blocked-run-repair|workflow-root-repair)$/u.test(String(source))
    ? input.task.replace(/^[\s\S]*?\nOriginal task:\s*/u, '') : input.task;
  const firstLine = task.trim().split('\n', 1)[0]!;
  if (!/^(?:resolve|repair|fix|retry|recover|complete|process)\s+(?:every|all)\b/iu.test(firstLine)
    || !/\bqueue\b|\b(?:failed|blocked)\b[^\n]*\b(?:workflows?|runs?|items?)\b/iu.test(firstLine)) return null;
  return 'Catch-all queue recovery wrappers are not admitted. Select one current original outcome in its existing family and owning project, with exact evidence and scope; preserve prior history.';
}

/** Prospective negative admission, including clients running older code. No
 * UPDATE trigger: historical runs, receipts, leases and claim fences are untouched.
 * Keep the predicate equivalent to automaticRecoveryWrapperReason above.
 */
export const automaticRecoveryAdmissionFenceSql = String.raw`
create or replace function deny_automatic_queue_recovery_wrapper() returns trigger language plpgsql as $fence$
declare producer text := NEW.evaluation_metadata->>'source'; first_line text;
begin
 if producer is null or producer not in ('server-orchestration','workflow-supervisor-repair','blocked-run-repair','workflow-root-repair','queue-partner-recovery') then return NEW; end if;
 first_line := NEW.task;
 if producer in ('workflow-supervisor-repair','blocked-run-repair','workflow-root-repair') then
  first_line := regexp_replace(first_line, '(?s)^.*?\nOriginal task:\s*', '');
 end if;
 first_line := split_part(regexp_replace(first_line, '^\s+|\s+$', '', 'g'), E'\n', 1);
 if first_line ~* '^(resolve|repair|fix|retry|recover|complete|process)\s+(every|all)\y'
 and first_line ~* '\yqueue\y|\y(failed|blocked)\y[^\n]*\y(workflows?|runs?|items?)\y' then
  raise exception using errcode='23514', constraint='workflow_runs_no_automatic_queue_wrapper',
   message='Catch-all queue recovery wrappers are not admitted. Select one current original outcome in its existing family and owning project, with exact evidence and scope; preserve prior history.';
 end if;
 return NEW;
end $fence$;
do $install$
begin
 if exists(select 1 from pg_trigger where tgrelid='workflow_runs'::regclass and tgname='workflow_runs_no_automatic_queue_wrapper') then
  if not exists(select 1 from pg_trigger where tgrelid='workflow_runs'::regclass and tgname='workflow_runs_no_automatic_queue_wrapper'
   and tgfoid='deny_automatic_queue_recovery_wrapper()'::regprocedure and tgtype=7 and tgenabled in ('O','A')) then
   raise exception 'Existing automatic recovery admission fence differs or is disabled; explicit reconciliation required';
  end if;
 else
  create trigger workflow_runs_no_automatic_queue_wrapper before insert on workflow_runs
   for each row execute function deny_automatic_queue_recovery_wrapper();
 end if;
end $install$;
`;
