import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, PluginOptions, Register, RenderNode } from 'claude-code'

import type { JbBranch, JbBuild, JbCheck, JbDiff, JbIssue, JbMerge, JbPr, JbPrDetail, JbSnapshot } from '../types'

// Read-only by design: the mod reads Bitbucket (through `bkt api`, reusing its
// keychain token) and Jira (through the connected mcp-atlassian server). Every
// write — a review comment, an approval, a transition — is handed to Claude as
// a prompt draft, so it goes through the session's normal permission prompts.

const PANE = 'jb'
const TITLE_KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,15}-[1-9]\d{0,6})(?!\d)/
const BRANCH_KEY = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,15}-[1-9]\d{0,6})(?!\d)/

const EMPTY: JbSnapshot = {
  updatedAt: 0,
  isLoading: false,
  error: null,
  jiraError: null,
  review: [],
  reviewHasMore: false,
  mine: [],
  issues: {},
  branch: null,
}

const snapshot = atom({ plugin: 'jira-bitbucket', key: 'snapshot' } as const, EMPTY)
const isBarCollapsed = atom({ plugin: 'jira-bitbucket', key: 'isBarCollapsed' } as const, true)
const BAR_COLLAPSED_KEY = 'barCollapsed'

type Api = EngineInterface

type Chip = { text: string; color?: string }

type Config = {
  bkt: string
  jiraServer: string
  jiraUrl: string
  refreshMs: number
  reviewLimit: number
  openOnStart: boolean
}

function configOf(options: PluginOptions): Config {
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback)
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback

  return {
    bkt: str(options.bkt, 'bkt'),
    jiraServer: str(options.jiraServer, 'atlassian'),
    jiraUrl: str(options.jiraUrl, '').replace(/\/+$/, ''),
    refreshMs: num(options.refreshMinutes, 3, 1, 60) * 60_000,
    reviewLimit: Math.round(num(options.reviewLimit, 20, 1, 100)),
    openOnStart: options.openOnStart === true,
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const firstLine = (text: string) => text.trim().split('\n')[0]?.slice(0, 200) ?? ''
const issueUrl = (cfg: Config, key: string) => (cfg.jiraUrl ? `${cfg.jiraUrl}/browse/${encodeURIComponent(key)}` : null)

// ---------------------------------------------------------------- Bitbucket

let bktBin: string | null = null

async function bkt($: Api, cfg: Config, args: string[]): Promise<any> {
  const candidates = bktBin ? [bktBin] : [...new Set([cfg.bkt, '/opt/homebrew/bin/bkt', '/usr/local/bin/bkt'])]
  let lastError = 'bkt not found'
  for (const bin of candidates) {
    let run
    try {
      run = await $.process.run([bin, 'api', ...args], { timeoutMs: 30_000 })
    } catch (err) {
      lastError = `cannot run ${bin}: ${message(err)}`
      continue
    }
    bktBin = bin
    if (run.exitCode !== 0) {
      throw new Error(firstLine(run.stderr || run.stdout) || `bkt exited with ${run.exitCode}`)
    }
    return JSON.parse(run.stdout)
  }
  throw new Error(lastError)
}

function issueKeyOf(text: unknown, isBranch = false): string | null {
  const match = (isBranch ? BRANCH_KEY : TITLE_KEY).exec(typeof text === 'string' ? text : '')
  return match?.[1]?.toUpperCase() ?? null
}

function toPr(v: any): JbPr {
  const repo = v.toRef?.repository ?? {}
  const props = v.properties ?? {}
  return {
    id: Number(v.id),
    project: String(repo.project?.key ?? ''),
    repo: String(repo.slug ?? ''),
    title: String(v.title ?? ''),
    url: String(v.links?.self?.[0]?.href ?? ''),
    sha: String(v.fromRef?.latestCommit ?? ''),
    fromBranch: String(v.fromRef?.displayId ?? ''),
    toBranch: String(v.toRef?.displayId ?? ''),
    author: String(v.author?.user?.displayName ?? v.author?.user?.name ?? ''),
    updated: Number(v.updatedDate ?? 0),
    isDraft: v.draft === true,
    reviewers: (v.reviewers ?? []).map((r: any) => ({
      name: String(r.user?.displayName ?? r.user?.name ?? '?'),
      status: String(r.status ?? 'UNAPPROVED'),
    })),
    comments: Number(props.commentCount ?? 0),
    openTasks: Number(props.openTaskCount ?? 0),
    isConflicted: props.mergeResult?.outcome === 'CONFLICTED',
    build: null,
    issueKey: issueKeyOf(v.title) ?? issueKeyOf(v.fromRef?.displayId, true),
  }
}

async function dashboard($: Api, cfg: Config, role: 'REVIEWER' | 'AUTHOR', limit: number) {
  const unapproved = role === 'REVIEWER' ? '&participantStatus=UNAPPROVED' : ''
  const page = await bkt($, cfg, [
    `/rest/api/1.0/dashboard/pull-requests?role=${role}&state=OPEN&order=NEWEST&limit=${limit}${unapproved}`,
  ])
  const prs: JbPr[] = (page.values ?? []).map(toPr)
  return { prs, hasMore: page.isLastPage === false }
}

async function builds($: Api, cfg: Config, shas: string[]): Promise<Record<string, JbBuild>> {
  const unique = [...new Set(shas.filter(Boolean))]
  if (unique.length === 0) return {}
  const stats = await bkt($, cfg, ['/rest/build-status/1.0/commits/stats', '-X', 'POST', '-d', JSON.stringify(unique)])
  const out: Record<string, JbBuild> = {}
  for (const [sha, s] of Object.entries<any>(stats ?? {})) {
    const build = { ok: Number(s.successful ?? 0), failed: Number(s.failed ?? 0), running: Number(s.inProgress ?? 0) }
    if (build.ok + build.failed + build.running > 0) out[sha] = build
  }
  return out
}

// ---------------------------------------------------------------- git

async function gitHead($: Api, cwd: string) {
  const git = (args: string[]) => $.process.run(['git', ...args], { cwd, timeoutMs: 5_000 }).catch(() => null)

  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const name = head?.exitCode === 0 ? head.stdout.trim() : ''
  if (name === '' || name === 'HEAD') return null

  const remote = await git(['remote', 'get-url', 'origin'])
  const match =
    remote?.exitCode === 0 ? /[/:](?:scm\/)?([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.stdout.trim()) : null
  return {
    name,
    project: match?.[1]?.toUpperCase() ?? null,
    repo: match?.[2]?.toLowerCase() ?? null,
  }
}

const CLOSED_PR_DAYS = 7

function toCheck(v: any): JbCheck {
  const name = String(v.name ?? v.key ?? 'build')
  const state = v.state === 'SUCCESSFUL' ? 'ok' : v.state === 'INPROGRESS' ? 'running' : 'failed'
  return { name: name.split(' / ').pop()?.trim() || name, state, url: String(v.url ?? '') }
}

// The branch's newest PR in any state, as the GitHub bar shows it: merged and
// declined ones too while they are recent, with its checks and merge status.
async function branchPr(
  $: Api,
  cfg: Config,
  head: { name: string; project: string | null; repo: string | null },
): Promise<{ pr: JbPr; detail: JbPrDetail } | null> {
  if (!head.project || !head.repo) return null
  const repo = `/rest/api/1.0/projects/${encodeURIComponent(head.project)}/repos/${encodeURIComponent(head.repo)}`
  let first: any
  try {
    const at = encodeURIComponent(`refs/heads/${head.name}`)
    const page = await bkt($, cfg, [`${repo}/pull-requests?at=${at}&direction=OUTGOING&state=ALL&order=NEWEST&limit=1`])
    first = page.values?.[0]
  } catch {
    return null // not a Bitbucket remote, or no access: the branch just has no PR
  }
  if (!first) return null

  const isOpen = first.state === 'OPEN'
  const closedAt = Number(first.closedDate ?? first.updatedDate ?? 0)
  if (!isOpen && (await $.clock.now()) - closedAt > CLOSED_PR_DAYS * 86_400_000) return null

  const pr = toPr(first)
  const [checks, merge, diff] = await Promise.all([
    bkt($, cfg, [`/rest/build-status/1.0/commits/${pr.sha}?limit=50`])
      .then(page => (page.values ?? []).map(toCheck) as JbCheck[])
      .catch(() => [] as JbCheck[]),
    isOpen
      ? bkt($, cfg, [`${repo}/pull-requests/${pr.id}/merge`])
          .then((m): JbMerge => ({
            canMerge: m.canMerge === true,
            isConflicted: m.conflicted === true || m.outcome === 'CONFLICTED',
            vetoes: (m.vetoes ?? []).map((x: any) => String(x.summaryMessage ?? '')).filter(Boolean),
          }))
          .catch(() => null)
      : Promise.resolve(null),
    bkt($, cfg, [
      `/rest/api/latest/projects/${encodeURIComponent(pr.project)}/repos/${encodeURIComponent(pr.repo)}/pull-requests/${pr.id}/diff-stats-summary`,
    ])
      .then((d): JbDiff => ({
        files: Number(d.filesChanged ?? 0),
        added: Number(d.totalInsertions ?? 0),
        removed: Number(d.totalDeletions ?? 0),
      }))
      .catch(() => null),
  ])
  const state = isOpen ? (first.draft === true ? 'DRAFT' : 'OPEN') : first.state === 'MERGED' ? 'MERGED' : 'DECLINED'
  return { pr, detail: { state, checks, merge, diff } }
}

// ---------------------------------------------------------------- Jira

function mcpText(result: McpToolResult): string {
  return result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

function mcpJson(result: McpToolResult): any {
  const parse = (text: string) => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  let data: any = result.structuredContent ?? parse(mcpText(result))
  if (data && typeof data.result === 'string') data = parse(data.result)
  return data && typeof data === 'object' ? data : null
}

async function jiraIssues($: Api, cfg: Config, keys: string[]): Promise<Record<string, JbIssue>> {
  const out: Record<string, JbIssue> = {}
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50)
    const result = await $.mcp.call(cfg.jiraServer, 'jira_search', {
      jql: `key in (${chunk.join(',')})`,
      fields: 'summary,status',
      limit: 50,
    })
    const data = mcpJson(result)
    if (result.isError || !data) {
      throw new Error(firstLine(mcpText(result)) || 'jira_search failed')
    }
    for (const issue of data.issues ?? []) {
      out[issue.key] = {
        key: String(issue.key),
        summary: String(issue.summary ?? ''),
        status: String(issue.status?.name ?? ''),
        category: String(issue.status?.category ?? ''),
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- refresh

let inflight: Promise<void> | null = null

function refresh($: Api, cfg: Config): Promise<void> {
  inflight ??= load($, cfg).finally(() => {
    inflight = null
  })
  return inflight
}

async function load($: Api, cfg: Config): Promise<void> {
  await update($, snapshot, s => ({ ...s, isLoading: true }))
  const cwd = await $.session.cwd()

  let fresh: Omit<JbSnapshot, 'issues' | 'jiraError'>
  try {
    const [head, review, mine] = await Promise.all([
      gitHead($, cwd),
      dashboard($, cfg, 'REVIEWER', cfg.reviewLimit + 10),
      dashboard($, cfg, 'AUTHOR', 50),
    ])
    const found = head ? await branchPr($, cfg, head) : null
    const reviewPrs = review.prs.filter(p => !p.isDraft)
    const all = [...reviewPrs, ...mine.prs, ...(found ? [found.pr] : [])]
    const stats = await builds(
      $,
      cfg,
      all.map(p => p.sha),
    ).catch(() => ({}) as Record<string, JbBuild>)
    const withBuild = (p: JbPr): JbPr => ({ ...p, build: stats[p.sha] ?? null })
    const branch: JbBranch | null = head
      ? {
          ...head,
          issueKey: issueKeyOf(head.name, true),
          pr: found ? withBuild(found.pr) : null,
          detail: found?.detail ?? null,
        }
      : null

    fresh = {
      updatedAt: await $.clock.now(),
      isLoading: false,
      error: null,
      review: reviewPrs.map(withBuild),
      reviewHasMore: review.hasMore,
      mine: mine.prs.map(withBuild),
      branch,
    }
  } catch (err) {
    await update($, snapshot, s => ({ ...s, isLoading: false, error: message(err) }))
    return
  }

  const keys = [
    ...new Set(
      [
        fresh.branch?.issueKey,
        ...fresh.review.slice(0, cfg.reviewLimit).map(p => p.issueKey),
        ...fresh.mine.map(p => p.issueKey),
      ].filter((k): k is string => typeof k === 'string'),
    ),
  ]
  let issues: Record<string, JbIssue> | null = null
  let jiraError: string | null = null
  try {
    issues = await jiraIssues($, cfg, keys)
  } catch (err) {
    jiraError = message(err)
  }

  await update($, snapshot, prev => ({ ...fresh, issues: issues ?? prev.issues, jiraError }))
}

async function checkBranch($: Api, cfg: Config): Promise<void> {
  const { value } = await $.state.get({ plugin: 'jira-bitbucket', key: 'snapshot' })
  const head = await gitHead($, await $.session.cwd())
  if ((head?.name ?? null) !== (value?.branch?.name ?? null)) await refresh($, cfg)
}

// ---------------------------------------------------------------- text

const approvedOf = (pr: JbPr) => pr.reviewers.filter(r => r.status === 'APPROVED').length
const needsWorkOf = (pr: JbPr) => pr.reviewers.some(r => r.status === 'NEEDS_WORK')

function buildText(build: JbBuild | null): string {
  if (!build) return ''
  if (build.failed > 0) return 'build ✗'
  if (build.running > 0) return 'build …'
  return 'build ✓'
}

function buildColor(build: JbBuild | null): string | undefined {
  if (!build) return undefined
  if (build.failed > 0) return 'red'
  if (build.running > 0) return 'yellow'
  return 'green'
}

function statusColor(category: string): string | undefined {
  if (category === 'Done') return 'green'
  if (category === 'In Progress') return 'yellow'
  return undefined
}

function age(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function reviewPrompt(pr: JbPr): string {
  return (
    `Review Bitbucket PR ${pr.project}/${pr.repo}#${pr.id} "${pr.title}" (${pr.url}) with bkt: ` +
    `read the description, diff and existing comments, then give me a review with risks and suggested comments. ` +
    `Don't post comments, approve or decline without asking me.`
  )
}

function triagePrompt(pr: JbPr): string {
  return (
    `Check my Bitbucket PR ${pr.project}/${pr.repo}#${pr.id} "${pr.title}" (${pr.url}) with bkt: ` +
    `summarize reviewer feedback, open tasks, failing builds and merge conflicts, then propose what to change. ` +
    `Don't reply, resolve tasks or push without asking me.`
  )
}

const prRef = (pr: JbPr) => `${pr.project}/${pr.repo}#${pr.id} "${pr.title}" (${pr.url})`

function fixChecksPrompt(pr: JbPr, failed: JbCheck[]): string {
  const list = failed.map(c => (c.url ? `${c.name} (${c.url})` : c.name)).join(', ')
  return (
    `My Bitbucket PR ${prRef(pr)} has failing builds on its latest commit: ${list}. ` +
    `Find out why (open the build logs if you can reach them, otherwise reproduce locally) and fix it on this branch. ` +
    `Don't push without asking me.`
  )
}

function addressReviewPrompt(pr: JbPr): string {
  return (
    `Go through the review on my Bitbucket PR ${prRef(pr)} with bkt: requested changes, unresolved comments and open tasks. ` +
    `Fix what's needed on this branch and summarize what you changed. ` +
    `Don't reply to comments, resolve tasks or push without asking me.`
  )
}

function conflictsPrompt(pr: JbPr): string {
  return (
    `My Bitbucket PR ${prRef(pr)} has merge conflicts with ${pr.toBranch}. ` +
    `Fetch origin, merge origin/${pr.toBranch} into this branch and resolve the conflicts. ` +
    `Show me the resolution before committing, and don't push without asking me.`
  )
}

// The PR's state as the bar draws it: the icon's stroke, the text's colour.
const PR_STATE: Record<JbPrDetail['state'], { label: string; stroke: string; color?: string }> = {
  OPEN: { label: 'Open', stroke: '#1a7f37', color: 'green' },
  DRAFT: { label: 'Draft', stroke: '#6e7781' },
  MERGED: { label: 'Merged', stroke: '#8250df', color: 'magenta' },
  DECLINED: { label: 'Declined', stroke: '#cf222e', color: 'red' },
}

function prIconSvg(stroke: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" ` +
    `stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` +
    `<circle cx="4" cy="3.5" r="1.75"/><circle cx="4" cy="12.5" r="1.75"/><circle cx="12" cy="12.5" r="1.75"/>` +
    `<path d="M4 5.25v5.5"/><path d="M12 10.75V6.5a2 2 0 0 0-2-2H7.5"/><path d="M9.25 2.75 7.5 4.5l1.75 1.75"/></svg>`
  )
}

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

type Row = { key: string; icon: string; color?: string; label: string; value: string }

function checksRow(checks: JbCheck[]): Row {
  const row = { key: 'checks', label: 'Checks' }
  if (checks.length === 0) return { ...row, icon: '–', value: 'No builds reported' }
  const failed = checks.filter(c => c.state === 'failed')
  const running = checks.filter(c => c.state === 'running').length
  if (failed.length > 0) {
    return {
      ...row,
      icon: '✕',
      color: 'red',
      value: `${failed.length} of ${checks.length} failing · ${failed.map(c => c.name).join(', ')}`,
    }
  }
  if (running > 0) return { ...row, icon: '●', color: 'yellow', value: `${running} of ${checks.length} running` }
  return { ...row, icon: '✓', color: 'green', value: `${checks.length} passed` }
}

function reviewsRow(pr: JbPr): Row {
  const row = { key: 'reviews', label: 'Reviews' }
  const total = pr.reviewers.length
  const approved = approvedOf(pr)
  const changes = pr.reviewers.filter(r => r.status === 'NEEDS_WORK').map(r => r.name)
  const extras = [
    pr.openTasks > 0 ? `${pr.openTasks} open task${pr.openTasks === 1 ? '' : 's'}` : '',
    pr.comments > 0 ? `${pr.comments} comment${pr.comments === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  const value = (head: string) => [head, ...extras].join(' · ')
  if (changes.length > 0) {
    return {
      ...row,
      icon: '⚠',
      color: 'yellow',
      value: value(`Changes requested by ${changes.join(', ')} · ${approved} of ${total} approved`),
    }
  }
  if (total === 0) return { ...row, icon: '–', value: value('No reviewers') }
  if (approved === total) return { ...row, icon: '✓', color: 'green', value: value(`${approved} of ${total} approved`) }
  return { ...row, icon: '○', value: value(`${approved} of ${total} approved`) }
}

function mergeRow(pr: JbPr, detail: JbPrDetail): Row | null {
  const row = { key: 'merge', label: 'Merge' }
  if (detail.state === 'MERGED') return { ...row, icon: '✓', color: 'magenta', value: `Merged into ${pr.toBranch}` }
  if (detail.state === 'DECLINED') return { ...row, icon: '✕', color: 'red', value: 'Declined' }
  const merge = detail.merge
  if (!merge) return null
  if (merge.isConflicted) return { ...row, icon: '✕', color: 'red', value: `Conflicts with ${pr.toBranch}` }
  if (merge.canMerge) return { ...row, icon: '✓', color: 'green', value: 'Ready to merge' }
  return { ...row, icon: '○', value: `Blocked · ${merge.vetoes[0] ?? 'merge checks failed'}` }
}

function ciDot(checks: JbCheck[]): string | undefined {
  if (checks.some(c => c.state === 'failed')) return 'red'
  if (checks.some(c => c.state === 'running')) return 'yellow'
  return checks.length > 0 ? 'green' : undefined
}

function reviewPill(pr: JbPr): Chip | null {
  const total = pr.reviewers.length
  if (total === 0) return null
  const approved = approvedOf(pr)
  if (needsWorkOf(pr)) return { text: `⚠ ${approved}/${total}`, color: 'yellow' }
  return approved === total ? { text: `✓ ${approved}/${total}`, color: 'green' } : { text: `✓ ${approved}/${total}` }
}

function mergePill(detail: JbPrDetail): Chip | null {
  if (detail.state !== 'OPEN' || !detail.merge) return null
  if (detail.merge.isConflicted) return { text: 'Conflicts', color: 'red' }
  return detail.merge.canMerge ? { text: 'Ready to merge', color: 'green' } : null // blocked: the rows say why
}

async function draft($: Api, text: string): Promise<void> {
  const filled = await $.prompt.fill({ text, mode: 'replace' })
  if (!filled.isFilled) $.ui.toast('jira-bitbucket: could not fill the prompt box')
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const cfg = configOf(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    $.ui.status(undefined)
    const wasCollapsed = (await $.store.get(BAR_COLLAPSED_KEY)) !== false
    await update($, isBarCollapsed, () => wasCollapsed)
    await $.command.register({
      name: 'jb',
      description: 'Jira · Bitbucket pane: review queue and your open PRs',
      argumentHint: '[refresh|close]',
    })
    $.clock.every(cfg.refreshMs, () => void refresh($, cfg))
    void refresh($, cfg)
    if (cfg.openOnStart && e.isInteractive) void $.ui.open({ id: PANE, title: 'Jira · Bitbucket' })
    return started
  })

  on('command.run', { command: 'jb' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Jira · Bitbucket pane closed.' }
    }
    if (arg === 'refresh') {
      await refresh($, cfg)
      const { value } = await $.state.get({ plugin: 'jira-bitbucket', key: 'snapshot' })
      return { text: value?.error ? `Refresh failed: ${value.error}` : 'Jira · Bitbucket refreshed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Jira · Bitbucket' })
    void refresh($, cfg)
    return { text: opened.isPlaced ? 'Jira · Bitbucket pane opened.' : 'Jira · Bitbucket pane is waiting for room.' }
  })

  on('turn.complete', ($, e, next) => {
    if (!e.agentId) void checkBranch($, cfg).catch(() => undefined)
    return next(e)
  })

  // The current branch's PR above the prompt, after the desktop's GitHub bar. The
  // app's own bar above it already names the repo, branch and diff, so this one
  // carries what that one lacks: number, title, approvals and CI. Hovering the
  // number floats a summary card over the rows above (a hover reveal: the desktop
  // clips an absolute box at the band's edge unless a hover reveals it); clicking CI
  // unfolds the status rows and their actions above the bar.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await read($, snapshot)
    const pr = s.branch?.pr
    const detail = s.branch?.detail
    if (!pr || !detail) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Link } = ui
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const isTerminal = e.surface === 'terminal'
    const look = PR_STATE[detail.state] ?? PR_STATE.OPEN
    const isOpen = detail.state === 'OPEN' || detail.state === 'DRAFT'
    const failed = detail.checks.filter(c => c.state === 'failed')
    const issueKey = s.branch?.issueKey ?? pr.issueKey
    const issue = issueKey ? s.issues[issueKey] : undefined
    const issueHref = issueKey ? issueUrl(cfg, issueKey) : null
    const needsReviewWork = needsWorkOf(pr) || pr.openTasks > 0 || pr.comments > 0
    const isCollapsed = await read($, isBarCollapsed)
    const toggle = async () => {
      const collapsed = await update($, isBarCollapsed, value => !value)
      await $.store.set(BAR_COLLAPSED_KEY, collapsed)
    }
    const diff = detail.diff ?? null
    const columns = e.props.bodyColumns

    const icon = (key: string) =>
      Svg ? (
        <Box key={key} flexShrink={0}>
          <Svg source={prIconSvg(look.stroke)} alt={look.label} width={16} height={16} />
        </Box>
      ) : (
        <Box key={key} flexShrink={0}>
          <Text color={look.color} dimColor={!look.color}>
            ⎇
          </Text>
        </Box>
      )
    const text = (c: Chip) => (
      <Text color={c.color} dimColor={!c.color}>
        {c.text}
      </Text>
    )
    const group = (key: string, children: RenderNode[], gap = 1) => (
      <Box key={key} flexDirection="row" alignItems="center" columnGap={gap} flexShrink={0}>
        {children}
      </Box>
    )
    const number = pr.url ? <Link href={pr.url} label={`#${pr.id}`} /> : `#${pr.id}`

    // -- the tooltip card: absolute inside the keyed PR area (a hover group scope does
    // not reveal on the desktop), so it floats over the rows above and moves nothing
    const card = (
      <Box
        position="absolute"
        bottom={1}
        left={0}
        width={Math.min(72, Math.max(40, columns - 24))}
        display="none"
        hover={{ display: 'flex' }}
        flexDirection="column"
        borderStyle="round"
        borderDimColor
        backgroundColor="userMessageBackground"
        paddingX={1}
      >
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          {group('card-state', [icon('card-icon'), text({ text: look.label, color: look.color })])}
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text dimColor wrap="truncate-end">{`${pr.project}/${pr.repo} #${pr.id}`}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor>{`${age(s.updatedAt - pr.updated)} ago`}</Text>
          </Box>
        </Box>
        <Text bold>{pr.title}</Text>
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text dimColor wrap="truncate-end">
              {pr.author}
            </Text>
          </Box>
          {diff &&
            group('card-diff', [
              <Text color="green">{`+${thousands(diff.added)}`}</Text>,
              <Text color="red">{`−${thousands(diff.removed)}`}</Text>,
              text({ text: `· ${thousands(diff.files)} file${diff.files === 1 ? '' : 's'}` }),
            ])}
        </Box>
      </Box>
    )

    // -- the status rows the CI toggle unfolds
    const rows = [checksRow(detail.checks), reviewsRow(pr), mergeRow(pr, detail)].filter((r): r is Row => r !== null)
    const line = (key: string, mark: Chip, label: string, value: RenderNode) => (
      <Box key={key} flexDirection="row" columnGap={1}>
        <Box width={2} flexShrink={0}>
          <Text bold color={mark.color} dimColor={!mark.color}>
            {mark.text}
          </Text>
        </Box>
        <Box width={8} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {value}
        </Box>
      </Box>
    )
    const hasActions = isOpen && (failed.length > 0 || needsReviewWork || detail.merge?.isConflicted === true)
    const details = !isCollapsed && (
      <Box key="band-details" flexDirection="column" marginBottom={1}>
        {rows.map(r =>
          line(`band-row-${r.key}`, { text: r.icon, color: r.color }, r.label, <Text wrap="truncate-end">{r.value}</Text>),
        )}
        {issueKey &&
          line(
            'band-row-jira',
            { text: '◆', color: 'blue' },
            'Jira',
            <Text wrap="truncate-end">
              {issueHref ? <Link href={issueHref} label={issueKey} /> : issueKey}
              {issue ? ` · ${issue.status} · ${issue.summary}` : ''}
            </Text>,
          )}
        {hasActions && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
            {failed.length > 0 && (
              <Button
                key="band-fix-checks"
                label="Fix failing checks"
                variant="primary"
                onPress={() => void draft($, fixChecksPrompt(pr, failed))}
              />
            )}
            {needsReviewWork && (
              <Button
                key="band-review"
                label="Address review"
                variant="secondary"
                onPress={() => void draft($, addressReviewPrompt(pr))}
              />
            )}
            {detail.merge?.isConflicted && (
              <Button
                key="band-conflicts"
                label="Resolve conflicts"
                variant="secondary"
                onPress={() => void draft($, conflictsPrompt(pr))}
              />
            )}
          </Box>
        )}
      </Box>
    )

    // -- the bar; only the title gives way, then the approvals and merge state drop
    const review = columns >= 60 ? reviewPill(pr) : null
    const merge = columns >= 75 ? mergePill(detail) : null
    const dot = ciDot(detail.checks)
    const bar = (
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        <Box key="band-pr" flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
          {icon('bar-icon')}
          <Text bold color={look.color} underline>
            {number}
          </Text>
          {card}
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">
            {pr.title}
          </Text>
        </Box>
        {merge && group('bar-merge', [text(merge)])}
        {review && group('bar-review', [text(review)])}
        {group(
          'bar-ci',
          [
            <Text color={dot} dimColor={!dot}>
              ●
            </Text>,
            <Button key="band-toggle" label={isCollapsed ? 'CI ▼' : 'CI ▲'} plain dimColor onPress={() => void toggle()} />,
          ],
          0,
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={isTerminal ? 1 : 0}>
        {details}
        {bar}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const review = s.review.slice(0, cfg.reviewLimit)
    const hiddenReviews = s.review.length - review.length
    const base = [...s.review, ...s.mine].map(pr => pr.url).find(Boolean)
    const dashboardUrl = base ? `${new URL(base).origin}/dashboard` : null

    const header =
      s.updatedAt === 0
        ? s.isLoading
          ? 'Loading…'
          : 'Not loaded yet'
        : `Updated ${clock(s.updatedAt)}${s.isLoading ? ' · refreshing…' : ''}`

    const issueLine = (key: string | null) => {
      if (!key) return null
      const issue = s.issues[key]
      const href = issueUrl(cfg, key)
      return (
        <Box flexDirection="row" columnGap={1}>
          <Text>{href ? <Link href={href} label={key} /> : key}</Text>
          {issue && <Text color={statusColor(issue.category)}>{issue.status}</Text>}
          {issue && (
            <Text dimColor wrap="truncate-end">
              {issue.summary}
            </Text>
          )}
        </Box>
      )
    }

    const prRow = (pr: JbPr, kind: 'review' | 'mine') => {
      const id = `${kind}-${pr.project}-${pr.repo}-${pr.id}`.replace(/[^A-Za-z0-9_-]/g, '_')
      const approved = approvedOf(pr)
      const total = pr.reviewers.length
      const build = buildText(pr.build)
      const ago = age(s.updatedAt - pr.updated)
      return (
        <Box key={id} flexDirection="column" marginTop={1}>
          <Text bold wrap="truncate-end">
            {pr.title}
          </Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Text dimColor>{`#${pr.id} ${pr.project}/${pr.repo}`}</Text>
            <Text dimColor>{kind === 'review' ? `${pr.author} · ${ago}` : `→ ${pr.toBranch} · ${ago}`}</Text>
            {kind === 'mine' && (
              <Text color={total > 0 && approved === total ? 'green' : undefined}>{`✓${approved}/${total}`}</Text>
            )}
            {needsWorkOf(pr) && <Text color="yellow">⚠ needs work</Text>}
            {build && <Text color={buildColor(pr.build)}>{build}</Text>}
            {pr.isConflicted && <Text color="red">conflict</Text>}
            {pr.openTasks > 0 && <Text dimColor>{`${pr.openTasks} tasks`}</Text>}
            {pr.comments > 0 && <Text dimColor>{`${pr.comments} comments`}</Text>}
          </Box>
          {issueLine(pr.issueKey)}
          <Box flexDirection="row" columnGap={2}>
            {kind === 'review' ? (
              <Button
                key={`${id}-go`}
                label="Review with Claude"
                dimColor
                onPress={() => void draft($, reviewPrompt(pr))}
              />
            ) : (
              <Button
                key={`${id}-go`}
                label="Triage with Claude"
                dimColor
                onPress={() => void draft($, triagePrompt(pr))}
              />
            )}
            {pr.url && (
              <Text>
                <Link href={pr.url} label="Open in Bitbucket" />
              </Text>
            )}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>{header}</Text>
          <Button key="refresh" label="Refresh" hotkey="r" dimColor onPress={() => void refresh($, cfg)} />
        </Box>
        {s.error && <Text color="red">{`Bitbucket: ${s.error}`}</Text>}
        {s.jiraError && <Text color="yellow">{`Jira: ${s.jiraError}`}</Text>}

        <Box marginTop={1}>
          <Text bold>{`NEEDS MY REVIEW (${s.review.length}${s.reviewHasMore ? '+' : ''})`}</Text>
        </Box>
        {s.updatedAt > 0 && review.length === 0 && <Text dimColor>Nothing is waiting for you.</Text>}
        {review.map(pr => prRow(pr, 'review'))}
        {(hiddenReviews > 0 || s.reviewHasMore) && dashboardUrl && (
          <Box marginTop={1}>
            <Text dimColor>
              {`${hiddenReviews > 0 ? `+${hiddenReviews}${s.reviewHasMore ? '+' : ''} more · ` : ''}`}
              <Link href={dashboardUrl} label="Bitbucket dashboard" />
            </Text>
          </Box>
        )}

        <Box marginTop={2}>
          <Text bold>{`MY OPEN PRS (${s.mine.length})`}</Text>
        </Box>
        {s.updatedAt > 0 && s.mine.length === 0 && <Text dimColor>No open pull requests.</Text>}
        {s.mine.map(pr => prRow(pr, 'mine'))}
      </Box>
    )
  })
}
