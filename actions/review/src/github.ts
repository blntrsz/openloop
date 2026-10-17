/**
 * Input for {@link commentOnPullRequest}.
 */
export interface CommentInput {
  /**
   * Repository to comment on, as `owner/name`.
   */
  readonly repository: string

  /**
   * Pull request number to comment on.
   */
  readonly pullRequest: string

  /**
   * Token with `pull-requests: write` on the repository.
   */
  readonly token: string

  /**
   * Comment body, as Markdown.
   */
  readonly body: string
}

/**
 * Post a comment on a pull request.
 *
 * Pull requests are issues to the REST API, so comments are created through the
 * `issues` endpoint.
 */
export const commentOnPullRequest = async (input: CommentInput): Promise<void> => {
  const response = await fetch(
    `https://api.github.com/repos/${input.repository}/issues/${input.pullRequest}/comments`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28'
      },
      body: JSON.stringify({ body: input.body })
    }
  )

  if (!response.ok) {
    throw new Error(
      `actions/review: GitHub rejected the comment with ${response.status} ${response.statusText}: ${await response.text()}`
    )
  }
}
