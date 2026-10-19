import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Effect } from 'effect'
import { Agent } from '../../../src/_agent/agent.ts'
import { layer as OpenCodeAgent } from '../../../src/_agent/opencode-agent.ts'
import {
  atLeast,
  isSeverity,
  listMarkedComments,
  publishReview,
  readSticky,
  severityRank,
  type Finding,
  type MarkedComment,
  type Severity,
  type StickyComment
} from './github.ts'

/**
 * Models used when the action does not provide one.
 *
 * An OpenCode free model, which the CLI runs inside the OpenCode identity, so
 * no credentials are needed. Any other provider needs its own credentials in
 * the environment. The variant after `#` is the effort level, so the review
 * runs at high effort and the reconciliation at low.
 */
const defaultReviewModel = 'opencode/glm-5.3-flash-free#high'
const defaultEvaluateModel = 'opencode/glm-5.3-flash-free#low'

/**
 * Read the skill sent to the review agent.
 *
 * `input` is a path to a skill directory (containing `SKILL.md`) or directly
 * to a skill file, resolved against the workspace.
 */
const readSkill = (input: string): string => {
  const path = resolve(process.cwd(), input)
  let file = path
  try {
    if (statSync(path).isDirectory()) file = join(path, 'SKILL.md')
  } catch {
    throw new Error(`actions/review: skill not found at ${path}`)
  }
  return readFileSync(file, 'utf8')
}

/**
 * Is this value a finding in the shape the skill promises? A finding whose
 * `endLine` is not a usable line number is tolerated here and stripped of it
 * during normalisation below.
 */
const isFinding = (value: unknown): value is Finding => {
  if (typeof value !== 'object' || value === null) return false
  const finding = value as Record<string, unknown>
  if (
    typeof finding.file !== 'string' ||
    finding.file === '' ||
    typeof finding.startLine !== 'number' ||
    !Number.isInteger(finding.startLine) ||
    finding.startLine < 1 ||
    !isSeverity(finding.severity) ||
    typeof finding.comment !== 'string'
  ) {
    return false
  }
  const { endLine } = finding
  // An unusable double like NaN is tolerated so the finding survives; the
  // normalisation strips it down to a single-line finding.
  return endLine === undefined || typeof endLine === 'number'
}

/**
 * Is this value the review report's shape?
 */
const isReport = (value: unknown): value is { summary: string; findings: Finding[] } => {
  if (typeof value !== 'object' || value === null) return false
  const report = value as Record<string, unknown>
  return typeof report.summary === 'string' && Array.isArray(report.findings) && report.findings.every(isFinding)
}

/**
 * The report the review agent was told to end with. Anything malformed fails
 * loudly, and the log above the error shows what the agent wrote.
 */
const parseReport = (text: string): { summary: string; findings: Finding[] } => {
  // The report is read strictly first: everything after the labelled block,
  // which fails a block that closes early or holds JSON with triple
  // backticks inside a comment. When the agent wrote prose after its fence,
  // the lazy variant stops at the first closing fence instead.
  const strict = text.match(/`{3,}openloop-review[ \t]*\r?\n([\s\S]*)$/)
  const lazy = strict === null ? null : text.match(/`{3,}openloop-review[ \t]*\r?\n([\s\S]*?)\n`{3,}[ \t]*\r?\n?/)
  if (strict === null || strict[1] === undefined) {
    throw new Error('actions/review: the review does not end with an ```openloop-review block')
  }

  let block = strict[1].replace(/`{3,}[ \t]*\s*$/, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch {
    // Fall back to the lazily bounded block before giving up.
    block = lazy?.[1]?.trim() ?? block
    try {
      parsed = JSON.parse(block)
    } catch (error) {
      throw new Error(
        `actions/review: the review report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  if (!isReport(parsed)) {
    throw new Error(
      'actions/review: the review report needs `summary` (string) and `findings` (list of `file`, `startLine`, `endLine`, `severity`, `comment`)'
    )
  }

  // A range written backwards still reads fine in prose, but the commenting
  // API needs its ends in order, and an unusable double is stripped.
  return {
    ...parsed,
    findings: parsed.findings.map((finding) => {
      const usable =
        finding.endLine === undefined ||
        (Number.isInteger(finding.endLine) && finding.endLine >= 1)
          ? finding.endLine
          : undefined
      if (usable !== undefined && usable < finding.startLine) {
        return { ...finding, startLine: usable, endLine: finding.startLine }
      }
      return { ...finding, endLine: usable }
    })
  }
}

/**
 * The reconciliation the evaluator was told to end with. Every previous
 * comment id must land in `keep` or `close`: an id in neither keeps, an id in
 * both keeps, an id the agent invented is dropped.
 */
const parseReconcile = (
  text: string,
  previous: readonly MarkedComment[]
): { kept: MarkedComment[]; closeIds: number[] } => {
  // The evaluator may write notes after the block, and its JSON carries no
  // backticks, so stop at the first closing fence; the end-of-text form is
  // the fallback for an unclosed block.
  const match =
    text.match(/`{3,}openloop-reconcile[ \t]*\r?\n([\s\S]*?)\n`{3,}/) ??
    text.match(/`{3,}openloop-reconcile[ \t]*\r?\n([\s\S]*)$/)
  if (match === null || match[1] === undefined) {
    throw new Error('actions/review: the reconciliation does not end with an ```openloop-reconcile block')
  }

  const block = match[1].trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch (error) {
    throw new Error(
      `actions/review: the reconciliation is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('actions/review: the reconciliation needs `keep` and `close` lists of comment ids')
  }
  const lists = parsed as Record<string, unknown>
  const read = (label: string): number[] => {
    if (lists[label] === undefined) return []
    if (!Array.isArray(lists[label])) {
      throw new Error(`actions/review: the reconciliation's \`${label}\` must be a list of comment ids`)
    }
    return lists[label].map((id) => {
      const number = typeof id === 'string' ? Number(id) : id
      if (typeof number !== 'number' || !Number.isInteger(number)) {
        throw new Error(`actions/review: the reconciliation's \`${label}\` held a non-integer comment id`)
      }
      return number
    })
  }

  const known = new Set(previous.map((comment) => comment.id))
  const asked = {
    keep: (read('keep') ?? []).filter((id) => known.has(id)),
    close: (read('close') ?? []).filter((id) => known.has(id))
  }

  const unknown = ((read('keep') ?? []).concat(read('close') ?? []) as number[]).filter((id) => !known.has(id))
  if (unknown.length > 0) {
    console.error(`actions/review: evaluator spoke of unknown comment ids ${unknown.join(', ')}, ignored`)
  }

  const keepSet = new Set(asked.keep)
  const converging = new Set(asked.close.filter((id) => !keepSet.has(id)))

  // A comment the agent never decided on keeps, never gets destroyed.
  const undecided = previous.filter((comment) => !keepSet.has(comment.id) && !converging.has(comment.id))
  for (const comment of undecided) {
    console.error(`actions/review: evaluator did not decide comment ${comment.id}, keeping it`)
  }

  return {
    kept: previous.filter((comment) => keepSet.has(comment.id) || undecided.includes(comment)),
    closeIds: [...converging]
  }
}

/**
 * Model the reconciliation on what came before and what the new review
 * found. The evaluator decides per comment; the verdict and the comment
 * bodies themselves are executed deterministically afterwards.
 */
const reconcilePrompt = (
  previous: readonly MarkedComment[],
  previousSticky: StickyComment | undefined,
  findings: readonly Finding[]
): string => {
  const comments = previous
    .map(
      (comment) =>
        `- ID ${comment.id} — \`${comment.file}:${comment.startLine}\` · \`${comment.severity}${comment.fileLevel ? ', file-level' : ''}\`\n  «${comment.body.split('\n').slice(2).join(' ').trim().slice(0, 600)}»`
    )
    .join('\n')
  const current = findings
    .map(
      (finding) =>
        `- \`${finding.file}:${finding.startLine}${finding.endLine !== undefined ? `–${finding.endLine}` : ''}\` · \`${finding.severity}\`\n  «${finding.comment.replace(/\s+/g, ' ').slice(0, 600)}»`
    )
    .join('\n')
  const verdict =
    previousSticky === undefined ? 'this is the first round' : previousSticky.ready ? 'Ready to merge' : 'Not ready to merge'

  return `Another review round is about to publish on this pull request, and you reconcile it with what an earlier round left behind. The pull request changed since those comments: lines may have moved and code may have been fixed.

Decide, for every previous comment, whether the problem it describes still stands in the code today:

- **keep** when the code still has the problem — either because the newest finding list reports it again at that location, or because the problem persists although the newest review no longer touches those lines
- **close** when the code now addresses the problem, or when the comment is outdated or simply wrong

Judge by what the comments say about the code, not by similarity of wording between the two lists. A comment and a finding may word the same issue differently, and two different issues may sound alike.

<previous comments>
${comments}
</previous comments>

<newest findings>
${current || '(the newest review found nothing to report)'}
</newest findings>

<highest remaining issue before this reconciliation>
${verdict}. Previous round summary: ${previousSticky === undefined ? '' : previousSticky.body.split('\n').slice(3).join(' ').trim().slice(0, 400)}
</highest remaining issue before this reconciliation>

Finish your response with exactly one fenced code block labelled \`openloop-reconcile\`, and nothing outside it. Fence it with exactly three backticks. The block is one valid JSON object, and every previous comment id appears in exactly one of the two lists:

\`\`\`openloop-reconcile
{
  "keep": [4317788349, 4317788816],
  "close": [4317789184]
}
\`\`\`

Use empty lists when they apply. When in doubt about a comment, keep it.`
}

/**
 * `Agent` backed by the OpenCode CLI, whose own logs surface on stderr so
 * the run is observable on the CI runner.
 */
const runAgent = (prompt: string, model: string): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const agent = yield* Agent
      return yield* agent.prompt(prompt, { model })
    }).pipe(Effect.provide(OpenCodeAgent))
  )

const skillInput = process.env.INPUT_SKILL?.trim()
if (!skillInput) throw new Error('actions/review: the `skill` input is required')
const skillPrompt = readSkill(skillInput)

const reviewModel = process.env.INPUT_MODEL?.trim() || defaultReviewModel
const evaluateModel = process.env.INPUT_FAST_MODEL?.trim() || defaultEvaluateModel

/**
 * The lowest severity that gets to be seen: anything under it is dropped
 * before anything is posted or reconciled.
 */
const minimumSeverity = ((): Severity => {
  const value = process.env.INPUT_MIN_SEVERITY?.trim()
  if (value === undefined || value === '') return 'medium'
  if (!isSeverity(value)) {
    throw new Error(`actions/review: \`min-severity\` must be one of low, medium, high, critical; got ${value}`)
  }
  return value
})()

// ----- Phase 1: the review (smart model, high effort). -----

const reportText = await runAgent(skillPrompt, reviewModel)
console.log(reportText)

// An agent that answers with nothing has failed, and a silent run is worse
// than a red check: it looks like a review that found no problems.
if (!reportText.trim()) throw new Error('actions/review: the agent produced no review')

const report = parseReport(reportText)

/**
 * Findings above the threshold, merged by location: two findings at the same
 * `file|startLine` become one comment with the higher severity, so no earlier
 * comment is ever silently overwritten.
 */
const mergeByLocation = (findings: readonly Finding[]): Finding[] => {
  const groups = new Map<string, Finding[]>()
  for (const finding of findings) {
    const key = `${finding.file}|${finding.startLine}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [finding])
    else group.push(finding)
  }

  return [...groups.values()]
    .map((group) => {
      const first = group[0]
      if (first === undefined) throw new Error('actions/review: an empty group of findings was built')
      return {
        file: first.file,
        startLine: first.startLine,
        endLine: Math.max(
          ...group.map((finding) => finding.endLine ?? finding.startLine)
        ),
        severity: group.reduce((best, finding) =>
          severityRank[finding.severity] > severityRank[best.severity] ? finding : best
        ).severity,
        comment: group.map((finding) => finding.comment).join('\n\n---\n\n')
      }
    })
    .sort((a, b) => severityRank[b.severity] - severityRank[a.severity])
}

const publishedFindings = mergeByLocation(
  report.findings.filter((finding) => atLeast(finding.severity, minimumSeverity))
)
const dropped = report.findings.filter((finding) => !atLeast(finding.severity, minimumSeverity)).length
if (dropped > 0) {
  console.log(`actions/review: ${dropped} finding(s) below ${minimumSeverity} are not published`)
}

// ----- Phase 2 (fast model) and phase 3 (deterministic). The `comment`
// input only gates what lands on GitHub: a dry run reconciles read-only,
// so both agent phases are exercisable without posting. -----

const post = process.env.INPUT_COMMENT?.trim() !== 'false'
const token = process.env.GH_TOKEN?.trim()
const repository = process.env.GITHUB_REPOSITORY?.trim()
const pullRequest = process.env.GITHUB_PR_NUMBER?.trim()
const headSha = process.env.GITHUB_PR_HEAD_SHA?.trim()

if (token === undefined || repository === undefined || pullRequest === undefined) {
  console.error('actions/review: not talking to GitHub, GH_TOKEN, GITHUB_REPOSITORY, or GITHUB_PR_NUMBER is not set')
} else {
  const credentials = { repository, pullRequest, token }
  const previous = await listMarkedComments(credentials)
  const previousSticky = await readSticky(credentials)

  // ----- Phase 2: reconciliation (fast model, low effort). -----
  let kept: MarkedComment[] = []
  let closeIds: number[] = []

  if (previous.length === 0) {
    console.log('actions/review: no earlier round to reconcile with')
  } else if (post && headSha === undefined) {
    console.error('actions/review: no head SHA, skip the reconciliation and keep every earlier comment')
    kept = previous
  } else {
    const reconcileText = await runAgent(
      reconcilePrompt(previous, previousSticky, publishedFindings),
      evaluateModel
    )
    console.log(reconcileText)
    if (!reconcileText.trim()) throw new Error('actions/review: the evaluator produced no reconciliation')

    const decided = parseReconcile(reconcileText, previous)
    kept = decided.kept
    closeIds = decided.closeIds
    console.log(
      `actions/review: reconciliation keeps ${kept.length} and closes ${closeIds.length} of ${previous.length} comment(s)`
    )
  }

  // ----- Phase 3: everything from here is deterministic. Post it, or just
  // report it. -----
  if (!post) {
    console.log(
      `actions/review: would ${previousSticky === undefined ? 'create' : 'update'} the sticky comment and post ${publishedFindings.length} finding(s), closing ${closeIds.length} comment(s)`
    )
  } else {
    const published = await publishReview({
      credentials,
      headSha,
      summary: report.summary,
      findings: publishedFindings,
      kept,
      closeIds
    })

    console.log(
      `actions/review: ${published.sticky} the sticky comment, verdict ${published.ready ? '✅ ready' : '🚩 not ready'}, ` +
        `inline ${published.inlineCreated} created and ${published.inlineUpdated} updated, ` +
        `closed ${published.closedResolved} resolved and ${published.closedDeleted} deleted, ` +
        `${published.unanchored.length} not anchored`
    )
  }
}
