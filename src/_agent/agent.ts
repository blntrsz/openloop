import { Context, Effect } from 'effect'

/**
 * An agent that answers a single prompt.
 */
export class Agent extends Context.Service<
  Agent,
  {
    /**
     * Send a prompt to the agent.
     */
    readonly prompt: (input: string) => Effect.Effect<void>
  }
>()('openloop/Agent') {}
