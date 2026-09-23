CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  category text NOT NULL,
  source_path text NOT NULL,
  definition jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflows (
  id text PRIMARY KEY,
  name text NOT NULL,
  source_path text NOT NULL,
  definition jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  root_uri text NOT NULL,
  profile text NOT NULL DEFAULT 'enterprise',
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS projects_root_uri_idx
ON projects(root_uri);

CREATE TABLE IF NOT EXISTS project_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id),
  source_uri text NOT NULL,
  content_hash text NOT NULL,
  token_estimate integer NOT NULL DEFAULT 0,
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, source_uri)
);

CREATE TABLE IF NOT EXISTS project_index_state (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  head_commit text,
  indexed_files integer NOT NULL DEFAULT 0,
  deleted_files integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id),
  workflow_id text REFERENCES workflows(id),
  status text NOT NULL,
  task text NOT NULL,
  autonomy text NOT NULL,
  policy_profile text NOT NULL DEFAULT 'local',
  policy_snapshot jsonb NOT NULL DEFAULT '{}',
  policy_snapshot_hash text NOT NULL DEFAULT '',
  model_tier_override text,
  provider_override text,
  evaluation_metadata jsonb NOT NULL DEFAULT '{}',
  workflow_snapshot jsonb NOT NULL DEFAULT '{}',
  workflow_definition_version text NOT NULL DEFAULT '1',
  workflow_definition_hash text NOT NULL DEFAULT '',
  construction_rationale jsonb NOT NULL DEFAULT '{}',
  executor_snapshot jsonb NOT NULL DEFAULT '{}',
  state_version bigint NOT NULL DEFAULT 0,
  lease_epoch bigint NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  replacement_run_id uuid REFERENCES workflow_runs(id),
  compiled_brief_uri text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT workflow_runs_status_check CHECK (status IN ('queued','leased','running','completed','blocked','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS workflow_runs_replacement_run_idx
ON workflow_runs(replacement_run_id);

CREATE TABLE IF NOT EXISTS workflow_run_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  from_status text NOT NULL,
  to_status text NOT NULL,
  state_version bigint NOT NULL,
  lease_epoch bigint NOT NULL,
  actor text NOT NULL,
  reason text NOT NULL,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, idempotency_key),
  UNIQUE(run_id, state_version),
  CONSTRAINT workflow_run_transitions_from_status_check CHECK (from_status IN ('queued','leased','running','completed','blocked','failed','cancelled')),
  CONSTRAINT workflow_run_transitions_to_status_check CHECK (to_status IN ('queued','leased','running','completed','blocked','failed','cancelled'))
);

CREATE TABLE IF NOT EXISTS workflow_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES workflow_runs(id),
  stage_id text NOT NULL,
  agent_id text REFERENCES agents(id),
  status text NOT NULL,
  input_uri text,
  output_uri text,
  attempts integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  executor_snapshot jsonb NOT NULL DEFAULT '{}',
  worker_id text,
  lease_expires_at timestamptz,
  lease_generation bigint NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE(idempotency_key)
);

CREATE TABLE IF NOT EXISTS action_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES workflow_runs(id),
  agent_id text REFERENCES agents(id),
  action_type text NOT NULL,
  target text NOT NULL,
  summary text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  sender_agent_id text NOT NULL REFERENCES agents(id),
  receiver_agent_id text NOT NULL REFERENCES agents(id),
  source_stage_id text NOT NULL,
  destination_stage_id text NOT NULL,
  transferred_artifacts jsonb NOT NULL DEFAULT '[]',
  context_summary text NOT NULL,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected', 'retrying', 'completed', 'failed')),
  idempotency_key text NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  rejected_at timestamptz,
  retrying_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS workflow_handoff_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handoff_id uuid NOT NULL REFERENCES workflow_handoffs(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'retrying', 'completed', 'failed')),
  actor_agent_id text REFERENCES agents(id),
  note text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_handoff_receipts (
  handoff_id uuid NOT NULL REFERENCES workflow_handoffs(id) ON DELETE CASCADE,
  receipt_id uuid NOT NULL REFERENCES action_receipts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (handoff_id, receipt_id)
);

CREATE INDEX IF NOT EXISTS workflow_handoffs_run_status_idx
ON workflow_handoffs(run_id, status, proposed_at);

CREATE INDEX IF NOT EXISTS workflow_handoff_events_handoff_created_idx
ON workflow_handoff_events(handoff_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS workflow_handoff_events_one_proposal_idx
ON workflow_handoff_events(handoff_id) WHERE status = 'proposed';

CREATE TABLE IF NOT EXISTS action_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES workflow_runs(id),
  task_id uuid REFERENCES workflow_tasks(id),
  stage_id text NOT NULL,
  agent_id text REFERENCES agents(id),
  action_type text NOT NULL,
  target text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  rationale text NOT NULL,
  policy_decision jsonb NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL DEFAULT '{}',
  idempotency_key text NOT NULL,
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, task_id, action_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS action_approvals_status_created_idx
ON action_approvals(status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS action_approvals_run_level_idempotency_idx
ON action_approvals(run_id, action_type, idempotency_key)
WHERE task_id IS NULL;

CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES workflow_runs(id),
  task_id uuid REFERENCES workflow_tasks(id),
  kind text NOT NULL,
  uri text NOT NULL UNIQUE,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id),
  source_uri text NOT NULL,
  content_hash text NOT NULL,
  summary text NOT NULL,
  embedding vector(1536),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, source_uri, content_hash)
);

CREATE INDEX IF NOT EXISTS memory_items_embedding_idx
ON memory_items USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

CREATE INDEX IF NOT EXISTS workflow_tasks_status_available_idx
ON workflow_tasks(status, available_at);

CREATE TABLE IF NOT EXISTS work_intents (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  owner text NOT NULL,
  objective_hash text NOT NULL,
  file_scopes jsonb NOT NULL DEFAULT '[]',
  expires_at timestamptz NOT NULL,
  fencing_token bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, owner)
);

CREATE INDEX IF NOT EXISTS work_intents_active_idx ON work_intents(project_id, expires_at);

CREATE TABLE IF NOT EXISTS side_effect_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text NOT NULL,
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  target text NOT NULL,
  receipt jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'completed',
  claim_token uuid,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS artifacts_run_kind_idx
ON artifacts(run_id, kind, created_at);

-- Performance testing support (speed tests) - additive, idempotent
CREATE TABLE IF NOT EXISTS performance_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id),
  workflow_id text REFERENCES workflows(id),
  workload_hash text NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS performance_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  baseline_id uuid REFERENCES performance_baselines(id) ON DELETE CASCADE,
  run_id uuid REFERENCES workflow_runs(id) ON DELETE CASCADE,
  stage_id text NOT NULL,
  latency_ms double precision NOT NULL CHECK (latency_ms >= 0),
  cpu_ms double precision CHECK (cpu_ms IS NULL OR cpu_ms >= 0),
  memory_mb double precision CHECK (memory_mb IS NULL OR memory_mb >= 0),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS performance_baselines_project_created_idx
ON performance_baselines(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS performance_metrics_run_stage_idx
ON performance_metrics(run_id, stage_id);

CREATE INDEX IF NOT EXISTS performance_metrics_baseline_created_idx
ON performance_metrics(baseline_id, created_at DESC);

-- Hot-path indexes for dashboard speed (non-concurrently for init.sql)
CREATE INDEX IF NOT EXISTS workflow_runs_project_status_idx
ON workflow_runs(project_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS workflow_runs_workflow_status_idx
ON workflow_runs(workflow_id, status);

CREATE INDEX IF NOT EXISTS workflow_tasks_run_status_idx
ON workflow_tasks(run_id, status);

CREATE INDEX IF NOT EXISTS action_receipts_run_created_idx
ON action_receipts(run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS artifacts_task_kind_idx
ON artifacts(task_id, kind);
