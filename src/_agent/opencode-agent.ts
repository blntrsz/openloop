import { AbsolutePath, Location, OpenCode } from '@opencode/sdk/effect'
import { Effect, Layer } from 'effect'
import { Agent } from './agent.ts'

/**
 * An `Agent` implementation backed by OpenCode.
 *
 * Requires the `OpenCode.Service` SDK service, provided by `OpenCode.layer`.
 * Each `prompt` opens a session and waits for the agent to finish.
 */
export const layer = Layer.effect(
  Agent,
  Effect.gen(function* () {
    const opencode = yield* OpenCode.Service

    const prompt = Effect.fn('OpenCodeAgent.prompt')(
      function* (input: string) {
        const session = yield* opencode.sessions.create({
          title: 'openloop',
          location: Location.Ref.make({
            directory: AbsolutePath.make(process.cwd())
          })
        })

        yield* opencode.sessions.prompt({
          sessionID: session.id,
          text: input,
          resume: true
        })

        yield* opencode.sessions.wait({ sessionID: session.id })
      },
      Effect.orDie
    )

    return Agent.of({ prompt })
  })
)
