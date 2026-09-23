export const guardedAutonomySchemaSql = `
  CREATE TABLE IF NOT EXISTS authority_grants (
    id text PRIMARY KEY, project_id text NOT NULL, run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    stage_id text NOT NULL, grant_payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS breaker_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text NOT NULL, scope_id text NOT NULL,
    generation bigint NOT NULL, state text NOT NULL CHECK (state IN ('enabled','tripped','observe_only')),
    reason text NOT NULL, actor text NOT NULL, human_authored boolean NOT NULL DEFAULT false,
    evidence_hashes jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(scope, scope_id, generation)
  );
  CREATE TABLE IF NOT EXISTS provenance_memory_claims (
    id text PRIMARY KEY, project_id text NOT NULL, tenant_id text NOT NULL, source_hash text NOT NULL,
    claim jsonb NOT NULL, state text NOT NULL CHECK (state IN ('current','stale','disputed','revoked')),
    dependency_ids jsonb NOT NULL DEFAULT '[]'::jsonb, conflict_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS guarded_transactions (
    transaction_id text PRIMARY KEY, project_id text NOT NULL, receipt jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS promotion_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id text NOT NULL, baseline_hash text NOT NULL,
    candidate jsonb NOT NULL, evidence jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('proposed','approved','canary','promoted','rolled_back','quarantined','rejected')),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS promotion_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id uuid NOT NULL REFERENCES promotion_candidates(id) ON DELETE CASCADE,
    from_status text, to_status text NOT NULL, actor text NOT NULL, reason text NOT NULL,
    receipt jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS authority_grants_run_stage_idx ON authority_grants(run_id, stage_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS breaker_events_scope_idx ON breaker_events(scope, scope_id, generation DESC);
  CREATE INDEX IF NOT EXISTS provenance_memory_scope_idx ON provenance_memory_claims(project_id, tenant_id, state, created_at DESC);
  CREATE INDEX IF NOT EXISTS promotion_candidates_project_status_idx ON promotion_candidates(project_id, status, created_at DESC)
`;
