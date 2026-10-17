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

The agent diffs the pull request against its base branch (via `GITHUB_BASE_REF`), so the workflow checks out full history.

A run that produces no review fails the step, so missing credentials or a model the provider cannot route turn the check red instead of looking like a review that found nothing.

This project was created using `bun init` in bun v1.4.3. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
