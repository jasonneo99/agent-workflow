import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { withClient } from "../../../../packages/storage/src/client.js";
import type { StructuredAcceptanceContract } from "../../../../packages/model-providers/src/types.js";
import { assertApprovedCommandCoordinatorAuthority, type ApprovedCommandRunBinding } from "./approved-command-evidence.js";

test("real PostgreSQL command authority handles production text project intent IDs and UUID assignments", async () => {
  await withClient(async c => {
    await c.query("begin");
    try {
      const schema = `approved_command_authority_${randomUUID().replaceAll("-", "")}`;
      await c.query(`create schema ${schema};set local search_path to ${schema},public;
        create table queue_coordinator_assignments(id uuid,fence bigint,project_id uuid,child_run_id uuid,owner text,intent_fence text,file_scopes jsonb,state text);
        create table work_intents(project_id text,owner text,fencing_token bigint,file_scopes jsonb,expires_at timestamptz);`);
      const projectId=randomUUID(),runId=randomUUID(),claimId=randomUUID(),paths=["source.ts"];
      const run:ApprovedCommandRunBinding={runId,projectId,projectRootUri:"/synthetic/project",task:"Original task",coordinatorClaimId:claimId,coordinatorFence:"7",contract:{sourcePaths:paths} as StructuredAcceptanceContract};
      await c.query("insert into queue_coordinator_assignments values($1,7,$2,$3,'owner','9',$4::jsonb,'running')",[claimId,projectId,runId,JSON.stringify(paths)]);
      await c.query("insert into work_intents values($1,'owner',9,$2::jsonb,clock_timestamp()+interval '1 minute')",[projectId,JSON.stringify(paths)]);
      await assertApprovedCommandCoordinatorAuthority(c,run);
      await assert.rejects(assertApprovedCommandCoordinatorAuthority(c,{...run,runId:randomUUID()}),/exact live/u);
      await assert.rejects(assertApprovedCommandCoordinatorAuthority(c,{...run,projectId:randomUUID()}),/exact live/u);
      await assert.rejects(assertApprovedCommandCoordinatorAuthority(c,{...run,coordinatorFence:"8"}),/exact live/u);
      await c.query("update work_intents set expires_at=clock_timestamp()-interval '1 second'");
      await assert.rejects(assertApprovedCommandCoordinatorAuthority(c,run),/exact live/u);
      await c.query("update work_intents set expires_at=clock_timestamp()+interval '1 minute',file_scopes='[\"other.ts\"]'");
      await assert.rejects(assertApprovedCommandCoordinatorAuthority(c,run),/exact live/u);
      await c.query("update work_intents set file_scopes=$1::jsonb",[JSON.stringify(paths)]);
      await c.query("update queue_coordinator_assignments set state='held'");
      await assert.rejects(assertApprovedCommandCoordinatorAuthority(c,run),/exact live/u);
    } finally { await c.query("rollback"); }
  });
});
