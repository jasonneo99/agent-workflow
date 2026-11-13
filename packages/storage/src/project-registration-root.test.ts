import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { projectRegistrationRoot } from "./project-registration-root.js";

test("local Git proof links worktrees, rejects subdirectories, never guesses remote aliases",async()=>{
  const fixture=await fs.mkdtemp(path.join(os.tmpdir(),"aw-project-identity-"));
  try {
    const main=path.join(fixture,"main"),worktree=path.join(fixture,"branch"),nested=path.join(main,"module");
    await fs.mkdir(main);execFileSync("git",["init","-q",main]);
    execFileSync("git",["-C",main,"-c","user.name=Synthetic Fixture","-c","user.email=fixture@example.test","-c","commit.gpgsign=false","commit","--allow-empty","-qm","Synthetic temporary test only"]);
    execFileSync("git",["-C",main,"worktree","add","--detach",worktree],{stdio:"pipe"});
    await fs.mkdir(nested);
    assert.equal((await projectRegistrationRoot(main)).commonRoot,await fs.realpath(main));
    assert.equal((await projectRegistrationRoot(worktree)).commonRoot,await fs.realpath(main));
    await assert.rejects(projectRegistrationRoot(nested),/top-level repository/);
    const unknown="/unavailable-remote/independent-project";
    assert.deepEqual(await projectRegistrationRoot(unknown),{rootUri:unknown});
    await assert.rejects(projectRegistrationRoot("relative/path"),/absolute/);
  } finally { await fs.rm(fixture,{recursive:true,force:true}); }
});
