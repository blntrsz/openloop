import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { OpenCode } from '@opencode/sdk/effect'
import { Effect, Layer } from 'effect'
import { Agent } from '../../../src/_agent/agent.ts'
import { layer as OpenCodeAgent } from '../../../src/_agent/opencode-agent.ts'

/**
 * Model used when the action does not provide one.
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
 * `Agent` backed by OpenCode, with host logs surfaced on stderr so the run is
 * observable on the CI runner.
 */
const AgentLive = Layer.provide(
  OpenCodeAgent,
  OpenCode.layer({
    log: {
      level: 'info',
      emit: (entry) => console.error(entry.message, entry.attributes ?? '')
    }
  })
)

const program = Effect.gen(function* () {
  const agent = yield* Agent
  yield* agent.prompt(prompt, { model })
})

await Effect.runPromise(Effect.provide(program, AgentLive))
