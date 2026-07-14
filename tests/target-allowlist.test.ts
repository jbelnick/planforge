import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertAllowedTargetRepo, listAllowedTargetRepos } from "../src/target-allowlist";
import { createPlanForgeLoopConfig } from "../src/start-server";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "planforge-allowlist-"));
  tempDirs.push(root);
  // The two real project fixtures are standalone git repos (own .git dir), like real build targets.
  await mkdir(path.join(root, "projects", "products", "planforge", ".git"), { recursive: true });
  await mkdir(path.join(root, "projects", "research", "oracle", ".git"), { recursive: true });
  await mkdir(path.join(root, "projects-evil", "planforge"), { recursive: true });
  await mkdir(path.join(root, ".hermes"), { recursive: true });
  await mkdir(path.join(root, "shared-runtime", "planforge"), { recursive: true });
  await symlink(path.join(root, ".hermes"), path.join(root, "projects", "products", "hermes-link"));
  return root;
}

describe("PlanForge target allowlist", () => {
  it("accepts in-bucket project targets", async () => {
    const workspaceRoot = await createWorkspace();

    expect(() =>
      assertAllowedTargetRepo({ targetRepo: path.join(workspaceRoot, "projects", "products", "planforge"), workspaceRoot })
    ).not.toThrow();
    expect(() =>
      assertAllowedTargetRepo({ targetRepo: path.join(workspaceRoot, "projects", "research", "oracle"), workspaceRoot })
    ).not.toThrow();
  });

  it("rejects denied prefixes", async () => {
    const workspaceRoot = await createWorkspace();

    expect(() => assertAllowedTargetRepo({ targetRepo: path.join(workspaceRoot, ".hermes"), workspaceRoot })).toThrow(
      expect.objectContaining({
      code: "E_TARGET_NOT_ALLOWLISTED"
      })
    );
    expect(() => assertAllowedTargetRepo({ targetRepo: path.join(workspaceRoot, "shared-runtime", "planforge"), workspaceRoot })).toThrow(
      expect.objectContaining({ code: "E_TARGET_NOT_ALLOWLISTED" })
    );
  });

  it("rejects a tracked subdirectory of an enclosing repo (no own .git)", async () => {
    const workspaceRoot = await createWorkspace();
    // Simulate the estate umbrella: the workspace root is itself a git repo, and the target is a
    // tracked in-bucket subdirectory without its own .git. Worktree/branch/ff-merge operations on
    // such a target would act on the ENCLOSING umbrella repo, so the assertion must reject it.
    await mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
    await mkdir(path.join(workspaceRoot, "projects", "products", "tracked-subdir"), { recursive: true });

    expect(() =>
      assertAllowedTargetRepo({ targetRepo: path.join(workspaceRoot, "projects", "products", "tracked-subdir"), workspaceRoot })
    ).toThrow(expect.objectContaining({ code: "E_TARGET_NOT_ALLOWLISTED" }));
    expect(() =>
      assertAllowedTargetRepo({ targetRepo: path.join(workspaceRoot, "projects", "products", "tracked-subdir"), workspaceRoot })
    ).toThrow(/standalone git repo/);
  });

  it("accepts a .git FILE only when its gitdir resolves INSIDE the target; rejects escaping/symlinked .git", async () => {
    const workspaceRoot = await createWorkspace();

    // (1) A gitfile whose gitdir stays inside the target (a real in-tree worktree/submodule) is fine.
    const inTreeTarget = path.join(workspaceRoot, "projects", "products", "in-tree-worktree");
    await mkdir(path.join(inTreeTarget, ".git-store"), { recursive: true });
    await writeFile(path.join(inTreeTarget, ".git"), "gitdir: ./.git-store\n", "utf8");
    expect(() => assertAllowedTargetRepo({ targetRepo: inTreeTarget, workspaceRoot })).not.toThrow();

    // (2) A crafted gitfile pointing at the enclosing repo (`.git -> <umbrella>/.git`) re-opens the
    // enclosing-repo hazard and must be REJECTED — this is the exact bypass the old statSync accepted.
    await mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
    const escapingGitfileTarget = path.join(workspaceRoot, "projects", "products", "escaping-gitfile");
    await mkdir(escapingGitfileTarget, { recursive: true });
    await writeFile(path.join(escapingGitfileTarget, ".git"), `gitdir: ${path.join(workspaceRoot, ".git")}\n`, "utf8");
    expect(() => assertAllowedTargetRepo({ targetRepo: escapingGitfileTarget, workspaceRoot })).toThrow(
      expect.objectContaining({ code: "E_TARGET_NOT_ALLOWLISTED" })
    );

    // (3) A SYMLINKED .git (`.git -> ../../.git`) also re-opens the enclosing repo and is rejected.
    const symlinkedGitTarget = path.join(workspaceRoot, "projects", "products", "symlinked-git");
    await mkdir(symlinkedGitTarget, { recursive: true });
    await symlink(path.join(workspaceRoot, ".git"), path.join(symlinkedGitTarget, ".git"));
    expect(() => assertAllowedTargetRepo({ targetRepo: symlinkedGitTarget, workspaceRoot })).toThrow(
      expect.objectContaining({ code: "E_TARGET_NOT_ALLOWLISTED" })
    );

    // The check stays injectable for tests, mirroring the lister: the injected answer wins over the
    // on-disk .git state in both directions.
    const gitRepoTarget = path.join(workspaceRoot, "projects", "products", "planforge");
    expect(() => assertAllowedTargetRepo({ targetRepo: gitRepoTarget, workspaceRoot, isGitRepo: () => false })).toThrow(
      expect.objectContaining({ code: "E_TARGET_NOT_ALLOWLISTED" })
    );
    const plainDirTarget = path.join(workspaceRoot, "projects", "products", "tracked-subdir");
    await mkdir(plainDirTarget, { recursive: true });
    expect(() => assertAllowedTargetRepo({ targetRepo: plainDirTarget, workspaceRoot, isGitRepo: () => true })).not.toThrow();
  });

  it("uses realpath and segment boundaries instead of startsWith", async () => {
    const workspaceRoot = await createWorkspace();

    expect(() => assertAllowedTargetRepo({ targetRepo: path.join(workspaceRoot, "projects-evil", "planforge"), workspaceRoot })).toThrow(
      expect.objectContaining({ code: "E_TARGET_NOT_ALLOWLISTED" })
    );
    expect(() => assertAllowedTargetRepo({ targetRepo: path.join(workspaceRoot, "projects", "products", "hermes-link"), workspaceRoot })).toThrow(
      expect.objectContaining({ code: "E_TARGET_NOT_ALLOWLISTED" })
    );
    expect(() => assertAllowedTargetRepo({ targetRepo: path.join(workspaceRoot, "projects", "missing"), workspaceRoot })).toThrow(
      expect.objectContaining({ code: "E_TARGET_NOT_FOUND" })
    );
  });

  it("refuses to start when PLANFORGE_TARGET_REPO is unset (no silent cwd default)", async () => {
    const workspaceRoot = await createWorkspace();
    const runtimeRoot = path.join(workspaceRoot, "shared-runtime", "planforge");

    expect(() =>
      createPlanForgeLoopConfig({
        cwd: path.join(workspaceRoot, "projects", "products", "planforge"),
        env: { PLANFORGE_RUNTIME_ROOT: runtimeRoot },
        workspaceRoot
      })
    ).toThrow(expect.objectContaining({ code: "E_TARGET_REPO_UNSET" }));

    expect(() =>
      createPlanForgeLoopConfig({
        cwd: path.join(workspaceRoot, "projects", "products", "planforge"),
        env: { PLANFORGE_TARGET_REPO: "   ", PLANFORGE_RUNTIME_ROOT: runtimeRoot },
        workspaceRoot
      })
    ).toThrow(expect.objectContaining({ code: "E_TARGET_REPO_UNSET" }));
  });

  it("is wired into loop config and exempts runtimeRoot", async () => {
    const workspaceRoot = await createWorkspace();
    const runtimeRoot = path.join(workspaceRoot, "shared-runtime", "planforge");

    expect(() =>
      createPlanForgeLoopConfig({
        cwd: path.join(workspaceRoot, "projects", "products", "planforge"),
        env: {
          PLANFORGE_TARGET_REPO: path.join(workspaceRoot, "projects", "products", "hermes-link"),
          PLANFORGE_RUNTIME_ROOT: runtimeRoot
        },
        workspaceRoot
      })
    ).toThrow(expect.objectContaining({ code: "E_TARGET_NOT_ALLOWLISTED" }));

    expect(
      createPlanForgeLoopConfig({
        cwd: path.join(workspaceRoot, "projects", "products", "planforge"),
        env: {
          PLANFORGE_TARGET_REPO: path.join(workspaceRoot, "projects", "products", "planforge"),
          PLANFORGE_RUNTIME_ROOT: runtimeRoot
        },
        workspaceRoot
      })
    ).toMatchObject({
      targetRepo: path.join(workspaceRoot, "projects", "products", "planforge"),
      runtimeRoot
    });
  });

  it("uses PLANFORGE_WORKSPACE_ROOT when the checkout is outside the workspace", async () => {
    const workspaceRoot = await createWorkspace();
    const targetRepo = path.join(workspaceRoot, "projects", "products", "planforge");
    const runtimeRoot = path.join(workspaceRoot, "shared-runtime", "planforge");

    expect(
      createPlanForgeLoopConfig({
        cwd: path.join(os.tmpdir(), "standalone-planforge-checkout"),
        env: {
          PLANFORGE_WORKSPACE_ROOT: workspaceRoot,
          PLANFORGE_TARGET_REPO: targetRepo,
          PLANFORGE_RUNTIME_ROOT: runtimeRoot
        }
      })
    ).toMatchObject({ targetRepo, runtimeRoot });
  });

  it("parses optional effort defaults in loop config", async () => {
    const workspaceRoot = await createWorkspace();
    const targetRepo = path.join(workspaceRoot, "projects", "products", "planforge");
    const runtimeRoot = path.join(workspaceRoot, "shared-runtime", "planforge");

    expect(
      createPlanForgeLoopConfig({
        cwd: targetRepo,
        env: {
          PLANFORGE_TARGET_REPO: targetRepo,
          PLANFORGE_RUNTIME_ROOT: runtimeRoot,
          PLANFORGE_ARCHITECT_EFFORT: "max",
          PLANFORGE_BUILDER_EFFORT: "xhigh"
        },
        workspaceRoot
      })
    ).toMatchObject({
      architectEffort: "max",
      builderEffort: "xhigh"
    });

    const emptyEfforts = createPlanForgeLoopConfig({
      cwd: targetRepo,
      env: {
        PLANFORGE_TARGET_REPO: targetRepo,
        PLANFORGE_RUNTIME_ROOT: runtimeRoot,
        PLANFORGE_ARCHITECT_EFFORT: "",
        PLANFORGE_BUILDER_EFFORT: "   "
      },
      workspaceRoot
    });
    expect(emptyEfforts.architectEffort).toBeUndefined();
    expect(emptyEfforts.builderEffort).toBeUndefined();
  });

  it("rejects invalid loop config effort defaults", async () => {
    const workspaceRoot = await createWorkspace();
    const targetRepo = path.join(workspaceRoot, "projects", "products", "planforge");
    const runtimeRoot = path.join(workspaceRoot, "shared-runtime", "planforge");

    expect(() =>
      createPlanForgeLoopConfig({
        cwd: targetRepo,
        env: {
          PLANFORGE_TARGET_REPO: targetRepo,
          PLANFORGE_RUNTIME_ROOT: runtimeRoot,
          PLANFORGE_ARCHITECT_EFFORT: "maximum"
        },
        workspaceRoot
      })
    ).toThrow(expect.objectContaining({ code: "E_INVALID_EFFORT" }));

    expect(() =>
      createPlanForgeLoopConfig({
        cwd: targetRepo,
        env: {
          PLANFORGE_TARGET_REPO: targetRepo,
          PLANFORGE_RUNTIME_ROOT: runtimeRoot,
          PLANFORGE_BUILDER_EFFORT: "extreme"
        },
        workspaceRoot
      })
    ).toThrow(expect.objectContaining({ code: "E_INVALID_EFFORT" }));
  });

  it("parses model allowlists and validates loop config model defaults", async () => {
    const workspaceRoot = await createWorkspace();
    const targetRepo = path.join(workspaceRoot, "projects", "products", "planforge");
    const runtimeRoot = path.join(workspaceRoot, "shared-runtime", "planforge");

    expect(
      createPlanForgeLoopConfig({
        cwd: targetRepo,
        env: {
          PLANFORGE_TARGET_REPO: targetRepo,
          PLANFORGE_RUNTIME_ROOT: runtimeRoot,
          PLANFORGE_ARCHITECT_MODELS: "opus, sonnet",
          PLANFORGE_BUILDER_MODELS: "gpt-5.2-codex",
          PLANFORGE_ARCHITECT_MODEL: "sonnet",
          PLANFORGE_BUILDER_MODEL: "gpt-5.2-codex"
        },
        workspaceRoot
      })
    ).toMatchObject({
      architectModels: ["default", "opus", "sonnet"],
      builderModels: ["default", "gpt-5.2-codex"],
      architectModel: "sonnet",
      builderModel: "gpt-5.2-codex"
    });

    expect(() =>
      createPlanForgeLoopConfig({
        cwd: targetRepo,
        env: {
          PLANFORGE_TARGET_REPO: targetRepo,
          PLANFORGE_RUNTIME_ROOT: runtimeRoot,
          PLANFORGE_BUILDER_MODELS: "default",
          PLANFORGE_BUILDER_MODEL: "gpt-5.2-codex"
        },
        workspaceRoot
      })
    ).toThrow(expect.objectContaining({ code: "E_INVALID_MODEL" }));
  });
});

describe("listAllowedTargetRepos", () => {
  it("enumerates git projects under the four allowlisted buckets, skipping non-repos and denied roots", async () => {
    const workspaceRoot = await createWorkspace();

    const targets = listAllowedTargetRepos({
      workspaceRoot,
      isGitRepo: (dir) => dir.endsWith(path.join("products", "planforge"))
    });
    const labels = targets.map((target) => target.label);
    expect(labels).toContain("products/planforge");
    // The injected isGitRepo answers false for research/oracle → excluded despite its on-disk .git.
    expect(labels).not.toContain("research/oracle");
    // Denied roots and out-of-bucket dirs never appear.
    expect(labels.some((label) => label.includes("hermes") || label.includes("shared-runtime"))).toBe(false);
    // The path is absolute and resolves to the project dir (realpath, so /var -> /private/var on mac).
    expect(targets.find((target) => target.label === "products/planforge")?.path).toBe(
      await realpath(path.join(workspaceRoot, "projects", "products", "planforge"))
    );
  });

  it("uses injectable readers and returns an empty list for an empty estate (never throws)", () => {
    const targets = listAllowedTargetRepos({
      workspaceRoot: "/nonexistent-estate",
      readBucket: () => [],
      isGitRepo: () => true
    });
    expect(targets).toEqual([]);
  });
});
