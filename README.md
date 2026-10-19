# openloop

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

To type check:

```bash
bun check
```

## Review action

`actions/review` runs an OpenCode agent with a skill and posts the result as a comment on the pull request that triggered the run. The workflow wires it to `pull_request`.

The review runs on `opencode/glm-5.3-flash-free`, one of OpenCode's free models, through the OpenCode CLI, so it needs no provider credentials: the CLI runs inside the OpenCode identity, which is also what makes the free tier available on a CI runner. To review with another provider instead, point the `model` input at it and give the job that provider's credentials.

The review is one **sticky comment per pull request**—`✅ Ready to merge` or `🚩 Not ready to merge`—that is updated in place on every run, plus **one inline comment per finding** anchored to the diff.

Each run is three phases:

1. **Review** (the `model` input, effort variant after `#`): the agent diffs the PR against its base (`GITHUB_BASE_REF`) and reports every finding as severity `low` → `critical`. Findings below `min-severity` are dropped, and any `high` or `critical` surviving means the sticky title flips to 🚩.
2. **Reconcile** (the `fast-model` input, typically a low-effort variant): with the earlier round's comments and the new findings in context, a second agent decides which previous comments still stand (`keep`) and which are addressed (`close`).
3. **Publish** (deterministic TypeScript): closed conversations are resolved via GraphQL (falling back to deletion), repeated findings update their previous comment, new findings post inline, and the sticky comment is rewritten. Nothing the two agents say is posted verbatim; they only decide, the code renders.

Inline comments carry a hidden marker, so a following run updates them instead of duplicating. Findings the API cannot anchor to a changed hunk fall back to a file-level comment, and if even that fails they are spelled out in the sticky comment. The skill is in `actions/review/skills/review/SKILL.md`.

A run that produces no review fails the step, so missing credentials or a model the provider cannot route turn the check red instead of looking like a review that found nothing.

This project was created using `bun init` in bun v1.4.3. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
