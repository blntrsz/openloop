import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Effect } from 'effect'
import { Agent } from '../../../src/_agent/agent.ts'
import { layer as OpenCodeAgent } from '../../../src/_agent/opencode-agent.ts'
import { publishReview, type Finding, type Review } from './github.ts'

/**
 * Model used when the action does not provide one.
 *
 * An OpenCode free model, which the CLI runs inside the OpenCode identity, so
 * no credentials are needed. Any other provider needs its own credentials in
 * the environment.
 */
const defaultModel = 'opencode/glm-5.3-flash-free'

/**
 * Read the skill sent to the agent.
 *
 * `input` is a path to a skill directory (containing `SKILL.md`) or directly to
 * a skill file, resolved against the workspace.
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

const skill = process.env.INPUT_SKILL?.trim()
if (!skill) throw new Error('actions/review: the `skill` input is required')

const prompt = readSkill(skill)
const model = process.env.INPUT_MODEL?.trim() || defaultModel

/**
 * Is this value a finding in the shape the skill promises?
 */
const isFinding = (value: unknown): value is Finding => {
  if (typeof value !== 'object' || value === null) return false
  const finding = value as Record<string, unknown>
  return (
    typeof finding.file === 'string' &&
    typeof finding.startLine === 'number' &&
    Number.isInteger(finding.startLine) &&
    finding.startLine >= 1 &&
    (finding.endLine === undefined || typeof finding.endLine === 'number') &&
    (finding.severity === 'blocker' || finding.severity === 'nit') &&
    typeof finding.comment === 'string'
  )
}

/**
 * Is this value the reviewed shape?
 */
const isReview = (value: unknown): value is Review => {
  if (typeof value !== 'object' || value === null) return false
  const review = value as Record<string, unknown>
  return (
    typeof review.ready === 'boolean' &&
    typeof review.summary === 'string' &&
    Array.isArray(review.findings) &&
    review.findings.every(isFinding)
  )
}

/**
 * Parse the report the agent was told to end with.
 *
 * The report is a fence labelled `openloop-review` at the very end of the
 * response, holding one JSON object. Anything else is unparsable, so it fails
 * loudly and the log above the error shows what the agent wrote.
 */
const parseReview = (text: string): Review => {
  const match = text.match(/`{3,}openloop-review[ \t]*\r?\n([\s\S]*)$/)
  if (match === null) {
    throw new Error('actions/review: the review does not end with an ```openloop-review block')
  }

  const raw = match[1]
  if (raw === undefined) {
    throw new Error('actions/review: the review does not end with an ```openloop-review block')
  }

  const block = raw.replace(/`{3,}[ \t]*\s*$/, '').trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch (error) {
    throw new Error(`actions/review: the review report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!isReview(parsed)) {
    throw new Error(
      'actions/review: the review report needs `ready` (boolean), `summary` (string), and `findings` (list of `file`, `startLine`, `endLine`, `severity`, `comment`)'
    )
  }

  // A range given backwards still reads fine in prose, but the commenting API
  // needs its ends in order.
  return {
    ...parsed,
    findings: parsed.findings.map((finding) =>
      finding.endLine !== undefined && finding.endLine < finding.startLine
        ? { ...finding, startLine: finding.endLine, endLine: finding.startLine }
        : finding
    )
  }
}

/**
 * `Agent` backed by the OpenCode CLI, whose own logs surface on stderr so the
 * run is observable on the CI runner.
 */
const program = Effect.gen(function* () {
  const agent = yield* Agent
  return yield* agent.prompt(prompt, { model })
})

const reviewText = await Effect.runPromise(Effect.provide(program, OpenCodeAgent))
console.log(reviewText)

// An agent that answers with nothing has failed, and a silent run is worse than
// a red check: it looks like a review that found no problems.
if (!reviewText.trim()) throw new Error('actions/review: the agent produced no review')

const review = parseReview(reviewText)

/**
 * Publish the review as a sticky comment and inline comments, unless the input
 * disables it or the run has no pull request to comment on.
 */
if (process.env.INPUT_COMMENT?.trim() !== 'false') {
  const token = process.env.GH_TOKEN?.trim()
  const repository = process.env.GITHUB_REPOSITORY?.trim()
  const pullRequest = process.env.GITHUB_PR_NUMBER?.trim()
  const headSha = process.env.GITHUB_PR_HEAD_SHA?.trim()

  if (!token || !repository || !pullRequest) {
    console.error('actions/review: skipping comment, GH_TOKEN, GITHUB_REPOSITORY, or GITHUB_PR_NUMBER is not set')
  } else {
    if (!headSha) {
      console.error('actions/review: GITHUB_PR_HEAD_SHA is not set, findings cannot anchor to lines')
    }

    const published = await publishReview({
      credentials: { repository, pullRequest, token },
      headSha,
      review
    })

    console.log(
      `actions/review: ${published.sticky} the sticky comment, ` +
        `${published.inlineCreated} inline comments created, ${published.inlineUpdated} updated, ` +
        `${published.unanchored.length} could not anchor`
    )
  }
}
