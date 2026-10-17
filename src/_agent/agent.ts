import { Context, Effect } from 'effect'

/**
 * Options for a single {@link Agent.prompt} call.
 */
export interface PromptOptions {
  /**
   * Model that should answer, as `provider/model`.
   */
  readonly model?: string
}

/**
 * An agent that answers a single prompt.
 */
export class Agent extends Context.Service<
  Agent,
  {
    /**
     * Send a prompt to the agent.
     */
    readonly prompt: (input: string, options?: PromptOptions) => Effect.Effect<void>
  }
>()('openloop/Agent') {}
