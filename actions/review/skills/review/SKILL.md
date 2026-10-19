---
name: review
description: Review pull request changes and report concrete findings
---

Review the changes in this pull request.

Start by determining what changed:

- If `GITHUB_BASE_REF` is set, run `git diff origin/"$GITHUB_BASE_REF"...HEAD`.
- Otherwise, run `git diff HEAD`.

Then:

- Read the surrounding code for every changed file before judging it.
- Focus on correctness, edge cases, and consistency with the existing patterns in the repository.
- Skip praise and summaries that restate the diff.

Finish your response with exactly one fenced code block labelled `openloop-review`, and nothing outside it. Fence it with exactly three backticks — the example below is nested in four backticks only because it sits inside this document's own fence. The response is read programmatically: the verdict becomes the title of the review comment and every finding becomes an inline comment on the pull request.

````openloop-review
{
  "ready": false,
  "summary": "Overall judgement in two or three sentences of Markdown.",
  "findings": [
    {
      "file": "src/_agent/agent.ts",
      "startLine": 10,
      "endLine": 12,
      "severity": "blocker",
      "comment": "What is wrong, why it matters, and what to do instead, in self-contained Markdown."
    }
  ]
}
````

The block is one valid JSON object. JSON strings cannot span lines, so newline inside a `comment` are `\n`. No trailing commas.

**`ready`** marks whether the pull request can merge as it stands. Any finding of severity `blocker` means `false`; findings with severity `nit` keep it `true`. A pull request you find no issues in is `ready` with an empty `findings`.

**`findings`**, most important first, only findings you verified in the code:

- `file` is the path as `git diff` reports it.
- `startLine` and `endLine` are the lines the finding applies to, omitting `endLine` for a single line. Inline comments anchor to changed hunks of the diff, and the API rejects a line outside them, so anchor what you can and prefer the closest line inside a changed hunk when a judgment reaches beyond it.
- `comment` stands alone: a reader sees the code and the comment, not the rest of your review.

Do not comment on anything else after the block. Text outside it is discarded.
