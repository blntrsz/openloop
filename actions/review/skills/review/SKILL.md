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

Finish your response with exactly one fenced code block labelled `openloop-review`, and nothing outside it. Fence it with exactly three backticks — the example below is nested in four backticks only because it sits inside this document's own fence. The response is read programmatically: every finding becomes a comment on the pull request.

````openloop-review
{
  "summary": "Overall judgement in two or three sentences of Markdown.",
  "findings": [
    {
      "file": "src/_agent/agent.ts",
      "startLine": 10,
      "endLine": 12,
      "severity": "high",
      "comment": "What is wrong, why it matters, and what to do instead, in self-contained Markdown."
    }
  ]
}
````

The block is one valid JSON object. JSON strings cannot span lines, so newlines inside a `comment` are `\n`. No trailing commas. `summary` is required.

**`findings`**, most important first, every finding you can stand behind, however small — the action, not you, decides what gets posted and what the verdict is:

- `file` is the path as `git diff` reports it.
- `startLine` and `endLine` are the lines the finding applies to, omitting `endLine` for a single line. Inline comments anchor to changed hunks of the diff, and the API rejects a line outside them, so anchor what you can and prefer the closest line inside a changed hunk when a judgement reaches beyond it.
- `comment` stands alone: a reader sees the code and the comment, not the rest of your review.
- `severity` is one of, ranked:

  | severity | meaning |
  | --- | --- |
  | `critical` | Must not ship: data loss, a security hole, or the change does not do what it claims to do. |
  | `high` | Blocks the merge: wrong behaviour in a realistic case, or a clear violation of the code's own contract or invariants. |
  | `medium` | Should be addressed: a missed edge case, a fragile pattern, or inconsistency with the repository's conventions. |
  | `low` | Polish: naming, clarity, or style. |

Do not comment on anything else after the block. Text outside it is discarded.
