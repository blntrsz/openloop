import { Effect, Layer } from 'effect'
import { Agent, type PromptOptions } from './agent.ts'

/**
 * What a finished `opencode run` resolved to.
 */
interface RunResult {
  /**
   * Text of the agent's response, empty when it produced none.
   */
  readonly text: string

  /**
   * Why the run failed, present only when there is no text to review.
   */
  readonly failure?: {
    readonly type: string
    readonly message: string
  }
}

/**
 * The events `opencode run --format json` prints, one JSON object per line.
 */
interface OpenCodeEvent {
  readonly type?: string
  readonly part?: {
    readonly messageID?: string
    readonly text?: string
  }
  readonly error?: {
    readonly type?: string
    readonly message?: string
  }
}

/**
 * Spawn the OpenCode CLI and collect its response.
 *
 * The CLI exits 0 even when the run failed, so the NDJSON stream is the source
 * of truth: an `error` event reports the failure, and the text parts of the
 * last message that produced any are the response.
 */
const run = async (input: string, options?: PromptOptions): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [
      'opencode',
      'run',
      '--format', 'json',
      // The review reads files and runs git, so permission prompts that nobody
      // can answer on a CI runner must not block the run.
      '--auto',
      ...(options?.model ? ['--model', options.model] : [])
    ],
    cwd: process.cwd(),
    // The prompt travels over stdin: skill text can start with `---`, which an
    // argument would trip the CLI's flag parser on.
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit'
  })

  proc.stdin.write(input)
  proc.stdin.end()

  const [output, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited
  ])

  let failure: RunResult['failure']
  const parts = new Map<string, string[]>()

  for (const line of output.split('\n')) {
    if (!line.trim()) continue

    let event: OpenCodeEvent
    try {
      event = JSON.parse(line) as OpenCodeEvent
    } catch {
      continue
    }

    if (event.type === 'error') {
      failure ??= {
        type: event.error?.type ?? 'unknown',
        message: event.error?.message ?? 'the agent run failed'
      }
    } else if (event.type === 'text' && event.part?.text) {
      const list = parts.get(event.part.messageID ?? '') ?? []
      list.push(event.part.text)
      parts.set(event.part.messageID ?? '', list)
    }
  }

  // `Map` iterates in insertion order, and events arrive in message order, so
  // the last entry is the message the agent finished with.
  const messageID = [...parts.keys()].at(-1)
  const text = messageID === undefined ? '' : (parts.get(messageID) ?? []).join('\n\n')

  // Text that arrived looks like a run that only partially went through, and
  // that is still something worth reviewing: only a run with no text is a
  // dead run. Model rejections, a non-zero exit, or anything else that went
  // wrong when there is text to show stays a warning on stderr.
  if (text.trim()) {
    if (failure || exitCode !== 0) {
      console.error(
        `OpenCodeAgent: the run finished alongside ${failure ? `an error (${failure.message})` : `a non-zero exit (${exitCode})`}, keeping the review`
      )
    }
  } else {
    failure ??= exitCode !== 0
      ? { type: 'cli.exit', message: `opencode exited with ${exitCode}` }
      : { type: 'agent.silent', message: 'the agent produced no text' }
  }

  return { text, failure }
}

/**
 * An `Agent` implementation backed by the OpenCode CLI.
 *
 * Each `prompt` spawns `opencode run` in the working directory and parses the
 * NDJSON stream it prints. The CLI runs inside the OpenCode identity, so
 * OpenCode's free models work without extra credentials, on a development
 * machine as well as on a CI runner.
 */
export const layer = Layer.effect(
  Agent,
  Effect.gen(function* () {
    const prompt = Effect.fn('OpenCodeAgent.prompt')(
      function* (input: string, options?: PromptOptions) {
        const { text, failure } = yield* Effect.promise(() => run(input, options))

        // A provider may reject the credentials or the model, and then no
        // review exists. Surface the reason instead of resolving with empty
        // text that reads like a clean bill of health.
        if (failure) {
          return yield* Effect.fail(
            new Error(`OpenCodeAgent.prompt: the agent failed with ${failure.type}: ${failure.message}`)
          )
        }

        return text
      },
      Effect.orDie
    )

    return Agent.of({ prompt })
  })
)
