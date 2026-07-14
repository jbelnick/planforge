import type { CodexHandoff } from "../domain";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlList(items: readonly string[]): string {
  if (items.length === 0) {
    return "[]";
  }
  return items.map((item) => `  - ${yamlString(item)}`).join("\n");
}

function renderList(items: readonly string[]): string {
  return items
    .map((item) => {
      const [firstLine = "", ...rest] = item.split(/\r?\n/);
      return [`- ${firstLine}`, ...rest.map((line) => `  ${line}`)].join("\n");
    })
    .join("\n");
}

export function renderHandoffArtifact(handoff: CodexHandoff): string {
  const frontmatter = [
    'schema_version: "1.0"',
    `objective: ${yamlString(handoff.objective)}`,
    `project: ${yamlString(handoff.project)}`,
    "non_goals: []",
    "likely_files: []",
    "verification:",
    yamlList(handoff.verification),
    "stop_conditions:",
    yamlList(handoff.stop_conditions)
  ].join("\n");

  return [
    "---",
    frontmatter,
    "---",
    "",
    "## Objective",
    handoff.objective,
    "",
    "## Context",
    handoff.context,
    "",
    "## Constraints",
    handoff.constraints,
    "",
    "## Verification",
    renderList(handoff.verification),
    "",
    "## Stop Conditions",
    renderList(handoff.stop_conditions),
    ""
  ].join("\n");
}
