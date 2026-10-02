import type { CliContext } from "../lib/context.js";
import type { Command } from "commander";
import { writeProjectBundleState } from "../lib/builders-bundle.js";
import { buildBundleManifest, compareBundleManifests, loadCommittedBundleManifest } from "../../../../packages/agent-registry/src/manifest.js";
import { type ProjectBundleState, bundleTrustStorePath, publicKeyFingerprint, readBundleTrustStore, signBundleManifest, writeBundleTrustStore } from "../../../../packages/bundle-trust/src/index.js";
import fs from "node:fs/promises";
import path from "node:path";

export function registerBundleCommands(program: Command, ctx: CliContext): void {
  program
    .command("bundle-adopt")
    .description("Record the current reusable bundle as adopted by a project")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--force", "overwrite an existing .agent-workflow/bundle-state.json")
    .option("--json", "print machine-readable adoption output")
    .action(async (options: { project: string; force?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const result = await writeProjectBundleState(ctx, projectDir, Boolean(options.force));
      const statePath = path.join(projectDir, result.relativePath);
      const state = await ctx.readJsonFile<ProjectBundleState>(statePath);
      const output = { projectDir, statePath, status: result.status, state };
      if (options.json) {
        console.log(JSON.stringify(output, null, 2));
        return;
      }
      console.log(`${result.status === "written" ? "Recorded" : "Skipped existing"} bundle state: ${statePath}`);
      if (result.status === "skipped") console.log("Use --force after reviewing bundle-upgrade-preview to replace the recorded baseline.");
    });

  program
    .command("bundle-sign")
    .description("Create a detached Ed25519 signature using an external private key")
    .requiredOption("--private-key <file>", "PEM Ed25519 private key file")
    .requiredOption("--signer <id>", "signer identity")
    .option("--expires-at <timestamp>", "optional ISO-8601 expiration")
    .option("--out <file>", "signature output", path.join(ctx.rootDir, "agent-workflow.bundle.sig.json"))
    .action(async (options: { privateKey: string; signer: string; expiresAt?: string; out: string }) => {
      if (options.expiresAt && !Number.isFinite(Date.parse(options.expiresAt))) throw new Error("--expires-at must be an ISO-8601 timestamp");
      const manifest = await loadCommittedBundleManifest(ctx.rootDir);
      if (!manifest) throw new Error("Bundle manifest is missing.");
      const current = await buildBundleManifest(ctx.rootDir);
      const drift = compareBundleManifests(manifest, current);
      if (drift.length) throw new Error(`Refusing to sign a modified bundle: ${drift.join("; ")}`);
      const signature = signBundleManifest({ manifest, privateKey: await fs.readFile(path.resolve(options.privateKey), "utf8"), signerId: options.signer, expiresAt: options.expiresAt });
      const output = path.resolve(options.out);
      await fs.writeFile(output, `${JSON.stringify(signature, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
      console.log(`Wrote ${output}`);
      console.log(`Signer fingerprint: ${signature.signer.keyFingerprint}`);
    });

  program
    .command("bundle-trust")
    .description("List, add, or remove trusted bundle signer public keys")
    .option("--public-key <file>", "PEM public key to trust")
    .option("--signer <id>", "signer identity for the trusted key")
    .option("--remove <fingerprint>", "remove a trusted fingerprint")
    .option("--json", "print trust store JSON")
    .action(async (options: { publicKey?: string; signer?: string; remove?: string; json?: boolean }) => {
      const store = await readBundleTrustStore();
      if (options.publicKey) {
        if (!options.signer) throw new Error("--signer is required with --public-key");
        const publicKey = await fs.readFile(path.resolve(options.publicKey), "utf8");
        const fingerprint = publicKeyFingerprint(publicKey);
        store.keys = [...store.keys.filter((key) => key.fingerprint !== fingerprint), { fingerprint, signerId: options.signer, publicKey, trustedAt: new Date().toISOString() }];
        await writeBundleTrustStore(store);
      }
      if (options.remove) {
        store.keys = store.keys.filter((key) => key.fingerprint !== options.remove);
        await writeBundleTrustStore(store);
      }
      if (options.json) console.log(JSON.stringify(store, null, 2));
      else {
        console.log(`Bundle trust store: ${bundleTrustStorePath()}`);
        console.log(store.keys.length ? store.keys.map((key) => `- ${key.signerId}: ${key.fingerprint}`).join("\n") : "- No trusted signer keys.");
      }
    });

}
