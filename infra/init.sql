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
  compiled_brief_uri text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
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

CREATE INDEX IF NOT EXISTS artifacts_run_kind_idx
ON artifacts(run_id, kind, created_at);
