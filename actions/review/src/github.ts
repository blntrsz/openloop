/**
 * Access GitHub needs to publish a review.
 */
export interface Credentials {
  readonly repository: string
  readonly pullRequest: string
  readonly token: string
}

/**
 * The severities a finding can carry.
 */
export type Severity = 'low' | 'medium' | 'high' | 'critical'

/**
 * The rank of every severity. Comments post from `min-severity` upward, and
 * a `high` or `critical` anywhere flips the verdict to not ready.
 */
export const severityRank: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 }

/**
 * Is this value one of the four severities?
 */
export const isSeverity = (value: unknown): value is Severity =>
  value === 'low' || value === 'medium' || value === 'high' || value === 'critical'

/**
 * Does `severity` reach `minimum` on the rank?
 */
export const atLeast = (severity: Severity, minimum: Severity): boolean =>
  severityRank[severity] >= severityRank[minimum]

/**
 * One finding of a review.
 */
export interface Finding {
  readonly file: string
  readonly startLine: number
  readonly endLine?: number
  readonly severity: Severity
  readonly comment: string
}

/**
 * An inline comment of an earlier round this action authored, read back
 * through its hidden marker.
 */
export interface MarkedComment {
  readonly id: number
  readonly file: string
  readonly startLine: number
  readonly severity: Severity
  readonly fileLevel: boolean
  readonly body: string
}

/**
 * The sticky verdict comment of an earlier round.
 */
export interface StickyComment {
  readonly id: number
  readonly body: string
  readonly ready: boolean
}

/**
 * What publishing did, for the run log.
 */
export interface PublishResult {
  readonly sticky: 'created' | 'updated'
  readonly inlineCreated: number
  readonly inlineUpdated: number
  readonly closedResolved: number
  readonly closedDeleted: number
  readonly keptUnmatched: readonly MarkedComment[]
  readonly unanchored: readonly Finding[]
  readonly ready: boolean
}

/**
 * The marker that keeps the verdict a single comment between runs. It leads
 * the body, where the title carries the verdict.
 */
const STICKY_MARKER = '<!-- openloop-review:sticky -->'

/**
 * The marker prefix of an inline comment. What follows until ` -->` is the
 * `file|startLine|severity` key and, if the comment fell to file level, a
 * fourth `file` segment. First-round comments wrote the key down without the
 * severity and read back as `medium`.
 */
const INLINE_PREFIX = '<!-- openloop-review:inline '

/**
 * A comment as the REST API returns it.
 */
interface RestComment {
  readonly id: number
  readonly body: string
}

/**
 * One GitHub REST call, resolving with the status and parsed JSON. A non-JSON
 * body, for example a proxy's HTML error page, surfaces as the failed
 * attempt's content instead of throwing from the parser.
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
  let data: unknown
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }

  return { status: response.status, data }
}

/**
 * Raise on a failure that says publishing cannot work. A 422 instead means
 * the request is simply not placeable, which the callers fall back on.
 */
const expectOk = (attempt: { status: number; data: unknown }, what: string): void => {
  if (attempt.status >= 300) {
    throw new Error(
      `actions/review: GitHub rejected ${what} with ${attempt.status}: ${JSON.stringify(attempt.data).slice(0, 400)}`
    )
  }
}

/**
 * Fetch every page of a listing, 100 entries at a time, 10 pages at most.
 */
const paged = async (credentials: Credentials, path: string): Promise<RestComment[]> => {
  const [base, hasQuery] = path.includes('?') ? [path, true] : [path, false]
  const comments: RestComment[] = []
  for (let page = 1; ; page++) {
    const attempt = await request(
      'GET',
      `${base}${hasQuery ? '&' : '?'}per_page=100&page=${page}`,
      credentials.token
    )
    expectOk(attempt, 'listing comments')
    const items = attempt.data as RestComment[]
    comments.push(...items)
    if (items.length < 100 || page >= 10) break
  }
  return comments
}

/**
 * Read the hidden marker of an inline comment back into its key and
 * severity. Older rounds wrote the key without the severity, and those read
 * back as `medium` so a first-generation comment cannot block a merge.
 */
const parseMarker = (comment: RestComment): MarkedComment | undefined => {
  if (!comment.body.startsWith(INLINE_PREFIX)) return undefined
  const end = comment.body.indexOf(' -->')
  if (end === -1) return undefined

  const segments = comment.body.slice(INLINE_PREFIX.length, end).split('|')
  if (segments.length < 2) return undefined

  const [file, line, fourth, fifth] = segments
  const startLine = Number(line)
  if (!file || !Number.isInteger(startLine) || startLine < 1) return undefined

  // First-generation marker: `file|startLine` or `file|startLine|file`.
  if (segments.length === 2 || fourth === 'file') {
    return { id: comment.id, file, startLine, severity: 'medium', fileLevel: fourth === 'file', body: comment.body }
  }

  if (!isSeverity(fourth)) return undefined
  return {
    id: comment.id,
    file,
    startLine,
    severity: fourth,
    fileLevel: fifth === 'file',
    body: comment.body
  }
}

/**
 * Every inline comment of an earlier round, every page of them.
 */
export const listMarkedComments = async (credentials: Credentials): Promise<MarkedComment[]> => {
  const comments = await paged(
    credentials,
    `/repos/${credentials.repository}/pulls/${credentials.pullRequest}/comments`
  )
  return comments.flatMap((comment) => {
    const marked = parseMarker(comment)
    return marked === undefined ? [] : [marked]
  })
}

/**
 * The sticky verdict comment of an earlier round, or nothing when a previous
 * round never published.
 */
export const readSticky = async (credentials: Credentials): Promise<StickyComment | undefined> => {
  const comments = await paged(
    credentials,
    `/repos/${credentials.repository}/issues/${credentials.pullRequest}/comments`
  )
  const sticky = comments.find((comment) => comment.body.startsWith(STICKY_MARKER))
  if (sticky === undefined) return undefined
  return {
    id: sticky.id,
    body: sticky.body,
    ready: sticky.body.includes('## ✅ Ready to merge')
  }
}

/**
 * Resolve the conversation one of this action's inline comments opened, as
 * `resolved`, or `blocked` when GraphQL cannot do it for this comment — the
 * caller then falls back to deleting.
 */
export const resolveCommentThread = async (
  credentials: Credentials,
  commentId: number
): Promise<'resolved' | 'blocked'> => {
  const [owner, name] = credentials.repository.split('/')
  const threadsQuery = `
    query ($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              isResolved
              comments(first: 1) {
                nodes {
                  databaseId
                }
              }
            }
          }
        }
      }
    }`

  const nodes: { id: string; isResolved: boolean; comments?: { nodes?: { databaseId?: number }[] } }[] = []
  let after: string | undefined
  for (let page = 0; ; page++) {
    const listed = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credentials.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        query: threadsQuery,
        variables: { owner, name, number: Number(credentials.pullRequest), after }
      })
    })

    const threads = (await listed.json()) as {
      errors?: unknown
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
              nodes?: { id: string; isResolved: boolean; comments?: { nodes?: { databaseId?: number }[] } }[]
            }
          }
        }
      }
    }

    const pageOf = threads.data?.repository?.pullRequest?.reviewThreads
    if (threads.errors || pageOf === undefined) return 'blocked'

    nodes.push(...(pageOf.nodes ?? []))
    if (pageOf.pageInfo?.hasNextPage !== true || page >= 10) break
    after = pageOf.pageInfo.endCursor ?? undefined
  }

  const thread = nodes.find((node) => node.comments?.nodes?.[0]?.databaseId === commentId)
  if (thread === undefined) return 'blocked'
  if (thread.isResolved) return 'resolved'

  const mutation = `
    mutation ($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread {
          id
          isResolved
        }
      }
    }`

  const resolved = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credentials.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ query: mutation, variables: { threadId: thread.id } })
  })

  const done = (await resolved.json()) as {
    errors?: unknown
    data?: { resolveReviewThread?: { thread?: { isResolved?: boolean } } }
  }
  if (done.errors || done.data?.resolveReviewThread?.thread?.isResolved !== true) {
    console.error(`actions/review: resolving comment ${commentId}: the mutation failed: ${JSON.stringify(done.errors ?? done.data).slice(0, 300)}`)
    return 'blocked'
  }
  return 'resolved'
}

/**
 * Delete an inline comment, the closing fallback when a conversation cannot
 * be resolved.
 */
const deleteComment = async (credentials: Credentials, id: number): Promise<void> => {
  const attempt = await request(
    'DELETE',
    `/repos/${credentials.repository}/pulls/comments/${id}`,
    credentials.token
  )
  expectOk(attempt, `deleting comment ${id}`)
}

/**
 * A `location` label for a finding, as it reads in a comment.
 */
export const anchor = (finding: { file: string; startLine: number; endLine?: number }): string =>
  finding.endLine !== undefined && finding.endLine !== finding.startLine
    ? `${finding.file}:${finding.startLine}–${finding.endLine}`
    : `${finding.file}:${finding.startLine}`

/**
 * A one-line squash of a text, stopping at the limit with an ellipsis.
 */
const excerpt = (text: string, limit = 140): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/**
 * The body of an inline comment. The marker carries the dedupe key and
 * severity, and the header repeats the location so the comment reads
 * standalone.
 */
const inlineBody = (finding: Finding, fileLevel: boolean): string =>
  [
    `${INLINE_PREFIX}${finding.file}|${finding.startLine}|${finding.severity}${fileLevel ? '|file' : ''} -->`,
    `**\`${anchor(finding)}\`${fileLevel ? ' (file-level fallback)' : ''} · ${finding.severity}**`,
    '',
    finding.comment
  ].join('\n')

/**
 * Create one finding's comment, line-anchored where GitHub takes it and
 * file-level where it does not. The caller has already deduplicated.
 */
const place = async (
  credentials: Credentials,
  headSha: string,
  finding: Finding
): Promise<{ placed: 'inline' | 'file-level' | 'unanchored'; id?: number }> => {
  const range = finding.endLine !== undefined && finding.endLine > finding.startLine
  const lineAttempt = await request(
    'POST',
    `/repos/${credentials.repository}/pulls/${credentials.pullRequest}/comments`,
    credentials.token,
    {
      commit_id: headSha,
      path: finding.file,
      side: 'RIGHT',
      body: inlineBody(finding, false),
      ...(range
        ? { line: finding.endLine, start_line: finding.startLine, start_side: 'RIGHT' }
        : { line: finding.startLine })
    }
  )

  if (lineAttempt.status === 201) return { placed: 'inline', id: (lineAttempt.data as RestComment).id }
  if (lineAttempt.status !== 422) {
    throw new Error(
      `actions/review: GitHub rejected the inline comment at ${anchor(finding)} with ${lineAttempt.status}: ${JSON.stringify(lineAttempt.data).slice(0, 400)}`
    )
  }

  // The line is outside the changed hunks. A file-level comment still lands
  // in the file's review view.
  const fileAttempt = await request(
    'POST',
    `/repos/${credentials.repository}/pulls/${credentials.pullRequest}/comments`,
    credentials.token,
    {
      commit_id: headSha,
      path: finding.file,
      side: 'RIGHT',
      subject_type: 'file',
      body: inlineBody(finding, true)
    }
  )

  if (fileAttempt.status === 201) return { placed: 'file-level', id: (fileAttempt.data as RestComment).id }
  if (fileAttempt.status !== 422) {
    throw new Error(
      `actions/review: GitHub rejected the file-level comment on ${finding.file} with ${fileAttempt.status}: ${JSON.stringify(fileAttempt.data).slice(0, 400)}`
    )
  }

  // Not even the file changed in this pull request, so the finding rides
  // along in the sticky comment instead.
  return { placed: 'unanchored' }
}

/**
 * The sticky comment body: verdict, judgement, and a finding index, with the
 * kept comments that no finding repeated and any unanchored finding spelled
 * out, because there is no inline comment for either.
 */
const stickyBody = (input: {
  ready: boolean
  summary: string
  findings: readonly Finding[]
  keptUnmatched: readonly MarkedComment[]
  unanchored: readonly Finding[]
}): string => {
  const title = input.ready ? '✅ Ready to merge' : '🚩 Not ready to merge'
  const parts: string[] = [STICKY_MARKER, '', `## ${title}`, '', input.summary.trim()]

  if (input.findings.length > 0) {
    parts.push('', `### Findings (${input.findings.length})`, '')
    for (const finding of input.findings) {
      parts.push(`- \`${anchor(finding)}\` · \`${finding.severity}\` — ${excerpt(finding.comment)}`)
    }
  }

  if (input.keptUnmatched.length > 0) {
    parts.push('', '### Still open from earlier rounds', '')
    for (const comment of input.keptUnmatched) {
      const text = comment.body
        .split('\n')
        .slice(2)
        .filter((line) => !line.startsWith('<!--'))
        .join(' ')
      parts.push(`- \`${comment.file}:${comment.startLine}\` · \`${comment.severity}\` — ${excerpt(text)}`)
    }
  }

  if (input.unanchored.length > 0) {
    parts.push('', '### Findings that could not anchor in the diff', '')
    for (const finding of input.unanchored) {
      parts.push(`#### \`${anchor(finding)}\` · \`${finding.severity}\``, '', finding.comment.trim(), '')
    }
  }

  let body = parts.join('\n').trim()
  if (body.length > 55_000) {
    // GitHub caps an issue comment at 65,536 bytes; stay far under it.
    body = [
      STICKY_MARKER,
      '',
      `## ${title}`,
      '',
      excerpt(input.summary, 400),
      '',
      `(the review was too long to list in full; ${input.findings.length} findings, the runner log has the complete text)`
    ].join('\n')
  }

  return body
}

/**
 * Execute a reconciled plan: resolve what the evaluator closed, update the
 * comments it kept that a finding repeated, create the comments it did not,
 * and rewrite the single sticky verdict comment.
 *
 * The verdict title is deterministic: a `high` or `critical` finding, an
 * unanchorable one included, or a kept comment that still blocks, flips it.
 */
export const publishReview = async (input: {
  credentials: Credentials
  headSha?: string
  summary: string
  findings: readonly Finding[]
  kept: readonly MarkedComment[]
  closeIds: readonly number[]
}): Promise<PublishResult> => {
  const { credentials, headSha, summary, findings, kept, closeIds } = input

  let closedResolved = 0
  let closedDeleted = 0
  for (const id of closeIds) {
    if ((await resolveCommentThread(credentials, id)) === 'resolved') {
      closedResolved++
    } else {
      await deleteComment(credentials, id)
      closedDeleted++
    }
  }

  const keptByKey = new Map(kept.map((comment) => [`${comment.file}|${comment.startLine}`, comment] as const))
  let inlineCreated = 0
  let inlineUpdated = 0
  const unanchored: Finding[] = []

  for (const finding of findings) {
    const repeated = keptByKey.get(`${finding.file}|${finding.startLine}`)
    if (repeated !== undefined) {
      const attempt = await request(
        'PATCH',
        `/repos/${credentials.repository}/pulls/comments/${repeated.id}`,
        credentials.token,
        { body: inlineBody(finding, repeated.fileLevel) }
      )
      expectOk(attempt, `the inline comment at ${anchor(finding)}`)
      inlineUpdated++
      continue
    }

    if (headSha === undefined) {
      unanchored.push(finding)
      continue
    }
    const placed = await place(credentials, headSha, finding)
    if (placed.placed === 'unanchored') unanchored.push(finding)
    else inlineCreated++
  }

  const repeatedKeys = new Set(findings.map((finding) => `${finding.file}|${finding.startLine}`))
  const keptUnmatched = kept.filter((comment) => !repeatedKeys.has(`${comment.file}|${comment.startLine}`))

  const blocked =
    findings.some((finding) => severityRank[finding.severity] >= 2) ||
    keptUnmatched.some((comment) => severityRank[comment.severity] >= 2)

  const before = (await paged(
    credentials,
    `/repos/${credentials.repository}/issues/${credentials.pullRequest}/comments`
  )).find((comment) => comment.body.startsWith(STICKY_MARKER))

  const attempt =
    before === undefined
      ? await request('POST', `/repos/${credentials.repository}/issues/${credentials.pullRequest}/comments`, credentials.token, {
          body: stickyBody({ ready: !blocked, summary, findings, keptUnmatched, unanchored })
        })
      : await request('PATCH', `/repos/${credentials.repository}/issues/comments/${before.id}`, credentials.token, {
          body: stickyBody({ ready: !blocked, summary, findings, keptUnmatched, unanchored })
        })

  expectOk(attempt, before === undefined ? 'creating the sticky comment' : 'updating the sticky comment')

  return {
    sticky: before === undefined ? 'created' : 'updated',
    inlineCreated,
    inlineUpdated,
    closedResolved,
    closedDeleted,
    keptUnmatched,
    unanchored,
    ready: !blocked
  }
}
