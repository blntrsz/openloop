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

The agent needs a model, so credentials for that model's provider have to reach the step. Set `ANTHROPIC_API_KEY` as a repository secret, or point the `model` input at a provider you have configured. OpenCode's own free models are rejected outside the OpenCode application.

A run that produces no review fails the step, so missing credentials or a model the provider cannot route turn the check red instead of looking like a review that found nothing.

This project was created using `bun init` in bun v1.4.3. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
