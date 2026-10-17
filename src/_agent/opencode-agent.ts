import { AbsolutePath, Location, Model, OpenCode } from '@opencode/sdk/effect'
import { Effect, Layer } from 'effect'
import { Agent, type PromptOptions } from './agent.ts'

/**
 * An `Agent` implementation backed by OpenCode.
 *
 * Requires the `OpenCode.Service` SDK service, provided by `OpenCode.layer`.
 * Each `prompt` opens a session, waits for the agent to finish, and resolves
 * with the text of its final message. A run that the provider rejected fails
 * with the provider's error rather than resolving with empty text.
 */
export const layer = Layer.effect(
  Agent,
  Effect.gen(function* () {
    const opencode = yield* OpenCode.Service

    const prompt = Effect.fn('OpenCodeAgent.prompt')(
      function* (input: string, options?: PromptOptions) {
        const session = yield* opencode.sessions.create({
          title: 'openloop',
          model: options?.model ? Model.Ref.parse(options.model) : undefined,
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

        // Messages are returned newest first, so the newest assistant message is
        // the one the agent finished with.
        const { data } = yield* opencode.message.list({ sessionID: session.id, limit: 10 })

        const idle = data.find((message) => message.type === 'idle' && message.outcome === 'failed')
        const message = data.find((candidate) => candidate.type === 'assistant')
        const error =
          (idle?.type === 'idle' ? idle.error : undefined) ??
          (message?.type === 'assistant' ? message.error : undefined)

        // A provider that rejects the credentials or cannot route the model never
        // produces text, so surface its error instead of resolving with an empty
        // review that reads like a clean bill of health.
        if (error) {
          return yield* Effect.fail(
            new Error(`OpenCodeAgent.prompt: the agent failed with ${error.type}: ${error.message}`)
          )
        }

        if (message?.type !== 'assistant') return ''

        return message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n\n')
      },
      Effect.orDie
    )

    return Agent.of({ prompt })
  })
)
