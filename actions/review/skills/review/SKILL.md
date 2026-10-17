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
- Report concrete findings file by file, most important first. Skip praise and summaries that restate the diff.
