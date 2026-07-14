# Security policy

## Supported version

PlanForge is currently a preview. Security fixes target the latest `0.1.x`
release and the `main` branch.

## Report a vulnerability

Please use this repository's **Security → Report a vulnerability** flow. Do
not open a public issue for a suspected vulnerability or include secrets,
private repository contents, transcripts, or local paths in a public report.

## Operating boundary

PlanForge launches local code-writing processes and executes verifier commands
from repositories you select. Its security model assumes:

- The service stays on loopback or behind an authenticated private network.
- Every target repository is trusted and has its own standalone `.git` root.
- Runtime state and worktrees live outside the source checkout.
- Claude Code and Codex use local subscription sessions; API-key mode is not
  the supported path.
- A human reviews the proposed plan and resulting diff before accepting work.

Do not place PlanForge behind an unauthenticated public tunnel. The current
preview does not provide application-level user authentication.
