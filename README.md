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

The review lands as **one sticky comment per pull request**—`✅ Ready to merge` or `🚩 Not ready to merge`—that is updated in place on every run, plus **one inline comment per finding** anchored to the diff. Findings the API cannot anchor to a changed hunk fall back to a file-level comment, and if even that fails they are spelled out in the sticky comment. Each inline comment carries a marker, so a following run updates it instead of duplicating it: find the review in `actions/review/skills/review/SKILL.md`.

A run that produces no review fails the step, so missing credentials or a model the provider cannot route turn the check red instead of looking like a review that found nothing.

This project was created using `bun init` in bun v1.4.3. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
