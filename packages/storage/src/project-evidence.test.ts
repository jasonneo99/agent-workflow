import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { readProjectEvidenceGraph } from "./project-evidence.js";

test("real PostgreSQL projection isolates projects, handles absent projects, and signals bounded windows", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `evidence_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  const prior = process.env.DATABASE_URL;
  try {
    await admin.query(`create schema ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    await admin.query(`set search_path to ${schema}`);
    await admin.query(`create table projects(id uuid primary key,root_uri text);
      create table project_files(project_id uuid,source_uri text,content_hash text,updated_at timestamptz,metadata jsonb);
      create table workflow_runs(id uuid primary key,project_id uuid,task text,status text,updated_at timestamptz);
      create table artifacts(id uuid primary key,run_id uuid,kind text,created_at timestamptz);
      create table workflow_tasks(id uuid primary key,run_id uuid,agent_id text,status text,finished_at timestamptz)`);
    const a = randomUUID(), b = randomUUID(), run = randomUUID(), other = randomUUID();
    await admin.query("insert into projects values($1,'/synthetic/a'),($2,'/synthetic/b')", [a,b]);
    await admin.query("insert into workflow_runs values($1,$2,'Allowed','failed',now()),($3,$4,'Foreign','completed',now())", [run,a,other,b]);
    await admin.query("insert into artifacts values($1,$2,'report',now()),($3,$4,'Foreign artifact',now())", [randomUUID(),run,randomUUID(),other]);
    await admin.query("insert into workflow_tasks values($1,$2,'test-engineer','failed',now())", [randomUUID(),run]);
    await admin.query("insert into project_files values($1,'requirements.md','hash',now(),$2::jsonb)", [a,JSON.stringify({ evidenceEntries: [{ kind: "requirement", title: "R1", line: 2 }] })]);
    const graph = await readProjectEvidenceGraph("/synthetic/a");
    assert.deepEqual(new Set(graph.nodes.map(node => node.kind)), new Set(["source","requirement","run","artifact","failure","agent"]));
    assert.equal(graph.nodes.some(node => node.title.includes("Foreign")), false);
    assert.equal(graph.truncated, false);
    await admin.query("insert into project_files select $1,'src/file-' || n || '.ts','hash',now(),'{}'::jsonb from generate_series(1,201) n", [a]);
    const bounded = await readProjectEvidenceGraph("/synthetic/a");
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.nodes.filter(node => node.kind === "source").length, 200);
    assert.equal((await readProjectEvidenceGraph("/synthetic/missing")).status, "empty");
  } finally {
    if (prior === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prior;
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }
});
