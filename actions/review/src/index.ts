import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Effect } from 'effect'
import { Agent } from '../../../src/_agent/agent.ts'
import { layer as OpenCodeAgent } from '../../../src/_agent/opencode-agent.ts'
import { commentOnPullRequest } from './github.ts'

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
 * `Agent` backed by the OpenCode CLI, whose own logs surface on stderr so the
 * run is observable on the CI runner.
 */
const program = Effect.gen(function* () {
  const agent = yield* Agent
  return yield* agent.prompt(prompt, { model })
})

const review = await Effect.runPromise(Effect.provide(program, OpenCodeAgent))
console.log(review)

// An agent that answers with nothing has failed, and a silent run is worse than
// a red check: it looks like a review that found no problems.
if (!review.trim()) throw new Error('actions/review: the agent produced no review')

/**
 * Publish the review as a pull request comment, unless the input disables it or
 * the run has no pull request to comment on.
 */
if (process.env.INPUT_COMMENT?.trim() !== 'false') {
  const token = process.env.GH_TOKEN?.trim()
  const repository = process.env.GITHUB_REPOSITORY?.trim()
  const pullRequest = process.env.GITHUB_PR_NUMBER?.trim()

  if (!token || !repository || !pullRequest) {
    console.error('actions/review: skipping comment, GH_TOKEN, GITHUB_REPOSITORY, or GITHUB_PR_NUMBER is not set')
  } else {
    await commentOnPullRequest({ repository, pullRequest, token, body: review })
  }
}
