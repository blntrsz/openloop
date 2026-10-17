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

The review runs on `opencode/glm-5.3-flash-free`, one of OpenCode's free models, so it costs nothing to run. Free models still need a key from the OpenCode console: set `OPENCODE_API_KEY` as a repository secret, and the workflow passes it to the job. To review with another provider instead, point the `model` input at it and give the job that provider's credentials.

A run that produces no review fails the step, so missing credentials or a model the provider cannot route turn the check red instead of looking like a review that found nothing.

This project was created using `bun init` in bun v1.4.3. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
