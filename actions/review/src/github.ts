/**
 * Access GitHub needs to publish a review.
 */
export interface Credentials {
  readonly repository: string
  readonly pullRequest: string
  readonly token: string
}

/**
 * One finding of a review.
 */
export interface Finding {
  readonly file: string
  readonly startLine: number
  readonly endLine?: number
  readonly severity: 'blocker' | 'nit'
  readonly comment: string
}

/**
 * The review verdict and its findings.
 */
export interface Review {
  readonly ready: boolean
  readonly summary: string
  readonly findings: readonly Finding[]
}

/**
 * What publishing did, for the run log.
 */
export interface PublishResult {
  readonly sticky: 'created' | 'updated'
  readonly inlineCreated: number
  readonly inlineUpdated: number
  readonly unanchored: readonly Finding[]
}

/**
 * A comment as the REST API returns it.
 */
interface Comment {
  readonly id: number
  readonly body: string
}

/**
 * The marker that keeps the sticky comment a single comment between runs. It
 * is found by leading the comment body.
 */
const STICKY_MARKER = '<!-- openloop-review:sticky -->'

/**
 * The marker prefix of an inline comment, followed by ` | `-less `file|line`
 * key and ` -->`. The key deduplicates the comment against earlier rounds.
 */
const INLINE_PREFIX = '<!-- openloop-review:inline '

/**
 * A `location` label for a finding, as it reads in the comment.
 */
const anchor = (finding: Finding): string =>
  finding.endLine !== undefined && finding.endLine !== finding.startLine
    ? `${finding.file}:${finding.startLine}–${finding.endLine}`
    : `${finding.file}:${finding.startLine}`

/**
 * A one-line squash of a finding's comment for the sticky index, stopping at
 * the limit with an ellipsis.
 */
const excerpt = (comment: string, limit = 140): string => {
  const line = comment.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/**
 * GitHub caps an issue comment at 65,536 bytes; the sticky body stays well
 * under it, and anything longer is truncated rather than failing the run.
 */
const STICKY_LIMIT = 55_000

/**
 * One GitHub REST call, resolving with the status and parsed JSON.
 */
const request = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  token: string,
  body?: unknown
): Promise<{ status: number; data: unknown }> => {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })

  const text = response.status === 204 ? '' : await response.text()

  // A non-JSON body, for example a proxy's HTML error page, must surface as the
  // failed attempt's content instead of throwing from the parser.
  let data: unknown
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }

  return { status: response.status, data }
}

/**
 * Raise on a failure that says publishing cannot work at all. A 422 instead
 * means the request is simply not placeable, which the callers fall back on.
 */
const expectOk = (attempt: { status: number; data: unknown }, what: string): void => {
  if (attempt.status >= 300) {
    throw new Error(
      `actions/review: GitHub rejected ${what} with ${attempt.status}: ${JSON.stringify(attempt.data).slice(0, 400)}`
    )
  }
}

/**
 * The comments under an issue or pull request, every page of them.
 * Pull requests are issues, so the sticky comment lives here.
 */
const listIssueComments = async (credentials: Credentials): Promise<Comment[]> => {
  const comments: Comment[] = []
  for (let page = 1; ; page++) {
    const attempt = await request(
      'GET',
      `/repos/${credentials.repository}/issues/${credentials.pullRequest}/comments?per_page=100&page=${page}`,
      credentials.token
    )
    expectOk(attempt, 'listing the pull request comments')
    const items = attempt.data as Comment[]
    comments.push(...items)
    if (items.length < 100 || page >= 10) break
  }
  return comments
}

/**
 * The review comments pinned to lines or files of the pull request, every
 * page of them.
 */
const listReviewComments = async (credentials: Credentials): Promise<Comment[]> => {
  const comments: Comment[] = []
  for (let page = 1; ; page++) {
    const attempt = await request(
      'GET',
      `/repos/${credentials.repository}/pulls/${credentials.pullRequest}/comments?per_page=100&page=${page}`,
      credentials.token
    )
    expectOk(attempt, 'listing the review comments')
    const items = attempt.data as Comment[]
    comments.push(...items)
    if (items.length < 100 || page >= 10) break
  }
  return comments
}

/**
 * The marker of an inline comment this action wrote, as `file|line[file]`.
 */
const markerKey = (comment: Comment): string | undefined => {
  if (!comment.body.startsWith(INLINE_PREFIX)) return undefined
  const end = comment.body.indexOf(' -->')
  return end === -1 ? undefined : comment.body.slice(INLINE_PREFIX.length, end)
}

/**
 * The body of an inline comment: the marker carries the dedupe key, and the
 * header repeats the location so the comment reads standalone.
 */
const inlineBody = (finding: Finding, fileLevel: boolean): string =>
  [
    `${INLINE_PREFIX}${finding.file}|${finding.startLine}${fileLevel ? '|file' : ''} -->`,
    `**\`${anchor(finding)}\`${fileLevel ? ' (file-level fallback)' : ''} · ${finding.severity}**`,
    '',
    finding.comment
  ].join('\n')

/**
 * Create or update one finding's inline comment: the same finding at the same
 * location updates what earlier rounds left, and a comment that GitHub cannot
 * place falls back to a file-level comment, which still shows in the review.
 */
const placeFinding = async (
  credentials: Credentials,
  headSha: string,
  finding: Finding,
  existing: Map<string, Comment>,
  counts: { created: number; updated: number }
): Promise<'inline' | 'file-level' | 'unanchored'> => {
  const range = finding.endLine !== undefined && finding.endLine > finding.startLine
  const body = inlineBody(finding, false)

  // Try line-anchored placement for a changed hunk.
  if (existing.has(`${finding.file}|${finding.startLine}`)) {
    const comment = existing.get(`${finding.file}|${finding.startLine}`)!
    const attempt = await request(
      'PATCH',
      `/repos/${credentials.repository}/pulls/comments/${comment.id}`,
      credentials.token,
      { body }
    )
    expectOk(attempt, `the inline comment at ${anchor(finding)}`)
    counts.updated++
    return 'inline'
  }

  const lineAttempt = await request(
    'POST',
    `/repos/${credentials.repository}/pulls/${credentials.pullRequest}/comments`,
    credentials.token,
    {
      commit_id: headSha,
      path: finding.file,
      side: 'RIGHT',
      body,
      ...(range
        ? { line: finding.endLine, start_line: finding.startLine, start_side: 'RIGHT' }
        : { line: finding.startLine })
    }
  )

  if (lineAttempt.status === 201) {
    // Findings later in this round must see this comment as existing, or two
    // findings at the same startLine both create instead of updating.
    const placed = lineAttempt.data as Comment
    existing.set(`${finding.file}|${finding.startLine}`, placed)
    counts.created++
    return 'inline'
  }
  if (lineAttempt.status !== 422) {
    throw new Error(
      `actions/review: GitHub rejected the inline comment at ${anchor(finding)} with ${lineAttempt.status}: ${JSON.stringify(lineAttempt.data).slice(0, 400)}`
    )
  }

  // The line is outside the changed hunks. A file-level comment still lands in
  // the file's review view.
  const fileKey = `${finding.file}|${finding.startLine}|file`
  if (existing.has(fileKey)) {
    const comment = existing.get(fileKey)!
    const attempt = await request(
      'PATCH',
      `/repos/${credentials.repository}/pulls/comments/${comment.id}`,
      credentials.token,
      { body: inlineBody(finding, true) }
    )
    expectOk(attempt, `the file-level comment on ${finding.file}`)
    counts.updated++
    return 'file-level'
  }

  const fileAttempt = await request(
    'POST',
    `/repos/${credentials.repository}/pulls/${credentials.pullRequest}/comments`,
    credentials.token,
    { commit_id: headSha, path: finding.file, side: 'RIGHT', subject_type: 'file', body: inlineBody(finding, true) }
  )
  if (fileAttempt.status === 201) {
    const placed = fileAttempt.data as Comment
    existing.set(`${finding.file}|${finding.startLine}|file`, placed)
    counts.created++
    return 'file-level'
  }
  if (fileAttempt.status !== 422) {
    throw new Error(
      `actions/review: GitHub rejected the file-level comment on ${finding.file} with ${fileAttempt.status}: ${JSON.stringify(fileAttempt.data).slice(0, 400)}`
    )
  }

  // Not even the file changed in this pull request, so the finding rides along
  // in the sticky comment instead.
  return 'unanchored'
}

/**
 * The sticky comment body: verdict, judgement, and a finding index, with any
 * unanchored finding spelled out because there is no inline comment for it.
 */
const stickyBody = (review: Review, unanchored: readonly Finding[]): string => {
  const title = review.ready ? '✅ Ready to merge' : '🚩 Not ready to merge'
  const parts: string[] = [STICKY_MARKER, '', `## ${title}`, '', review.summary.trim()]

  if (review.findings.length > 0) {
    parts.push('', `### Findings (${review.findings.length})`, '')
    for (const finding of review.findings) {
      parts.push(`- \`${anchor(finding)}\` · \`${finding.severity}\` — ${excerpt(finding.comment)}`)
    }
  }

  if (unanchored.length > 0) {
    parts.push('', '### Findings that could not anchor in the diff', '')
    for (const finding of unanchored) {
      parts.push(`#### \`${anchor(finding)}\` · \`${finding.severity}\``, '', finding.comment.trim(), '')
    }
  }

  let body = parts.join('\n').trim()
  if (body.length > STICKY_LIMIT) {
    body = [
      STICKY_MARKER,
      '',
      `## ${title}`,
      '',
      excerpt(review.summary, 400),
      '',
      `(the review was too long to list in full; ${review.findings.length} findings, the runner log has the complete text)`
    ].join('\n')
  }

  return body
}

/**
 * Publish a review: inline comments per finding, then the single sticky
 * comment that carries the verdict and the index.
 */
export const publishReview = async (input: {
  credentials: Credentials
  headSha?: string
  review: Review
}): Promise<PublishResult> => {
  const { credentials, headSha, review } = input

  const existing = new Map<string, Comment>()
  for (const comment of await listReviewComments(credentials)) {
    const key = markerKey(comment)
    if (key !== undefined) existing.set(key, comment)
  }

  const counts = { created: 0, updated: 0 }
  const unanchored: Finding[] = []

  for (const finding of review.findings) {
    const placed =
      headSha === undefined
        ? 'unanchored'
        : await placeFinding(credentials, headSha, finding, existing, counts)
    if (placed === 'unanchored') unanchored.push(finding)
  }

  const previous = (await listIssueComments(credentials)).find((comment) => comment.body.startsWith(STICKY_MARKER))

  const attempt =
    previous === undefined
      ? await request(
          'POST',
          `/repos/${credentials.repository}/issues/${credentials.pullRequest}/comments`,
          credentials.token,
          { body: stickyBody(review, unanchored) }
        )
      : await request(
          'PATCH',
          `/repos/${credentials.repository}/issues/comments/${previous.id}`,
          credentials.token,
          { body: stickyBody(review, unanchored) }
        )

  expectOk(attempt, previous === undefined ? 'creating the sticky comment' : 'updating the sticky comment')

  return {
    sticky: previous === undefined ? 'created' : 'updated',
    inlineCreated: counts.created,
    inlineUpdated: counts.updated,
    unanchored
  }
}
