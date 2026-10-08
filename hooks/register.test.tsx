import { expect, mock, test } from 'claude-code/testing'

const HOST = 'https://stash.example.com'

const pr = (o: {
  id: number
  project: string
  repo: string
  title: string
  branch: string
  sha: string
  author: string
  reviewers: Array<[string, string]>
  tasks?: number
  comments?: number
}) => ({
  id: o.id,
  title: o.title,
  state: 'OPEN',
  draft: false,
  updatedDate: 9_000_000,
  fromRef: { displayId: o.branch, latestCommit: o.sha, repository: { slug: o.repo, project: { key: o.project } } },
  toRef: { displayId: 'master', repository: { slug: o.repo, project: { key: o.project } } },
  author: { user: { name: o.author, displayName: o.author } },
  reviewers: o.reviewers.map(([name, status]) => ({ user: { name, displayName: name }, status })),
  properties: { commentCount: o.comments ?? 0, openTaskCount: o.tasks ?? 0, mergeResult: { outcome: 'CLEAN' } },
  links: { self: [{ href: `${HOST}/projects/${o.project}/repos/${o.repo}/pull-requests/${o.id}` }] },
})

const REVIEW = {
  isLastPage: true,
  values: [
    pr({
      id: 37,
      project: 'SHOP',
      repo: 'perf',
      title: '[SHOP-207] add login rate',
      branch: 'feature/SHOP-207-login-rate',
      sha: 'aaa',
      author: 'Jane Doe',
      reviewers: [['me', 'UNAPPROVED']],
      comments: 2,
    }),
    { ...pr({ id: 38, project: 'X', repo: 'y', title: 'draft', branch: 'b', sha: 'zzz', author: 'Z', reviewers: [] }), draft: true },
  ],
}

const MINE = {
  isLastPage: true,
  values: [
    pr({
      id: 912,
      project: 'CORE',
      repo: 'core',
      title: 'Market Data: buildpacks',
      branch: 'feature/CORE-2043_md-buildpacks',
      sha: 'bbb',
      author: 'me',
      reviewers: [
        ['alice', 'APPROVED'],
        ['bob', 'NEEDS_WORK'],
      ],
      tasks: 1,
    }),
  ],
}

const ISSUES = {
  issues: [
    { key: 'CORE-2043', summary: 'Build images', status: { name: 'In Progress', category: 'In Progress' } },
    { key: 'SHOP-207', summary: 'Login rate', status: { name: 'Review', category: 'In Progress' } },
  ],
}

const ok = (body: unknown) => ({
  exitCode: 0 as number,
  stdout: JSON.stringify(body),
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

test('pane, band and status line show the queue, my PRs and the branch PR', { options: { jiraUrl: 'https://jira.example.com/' } }, async ($, on) => {
  mock.clock(on, { now: 10_000_000 })
  mock.store(on)
  const calls: string[] = []
  let status: string | undefined = 'never cleared'
  let filled = ''

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: '/work/core' }))
  // the engine draws nothing of its own above the prompt
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  const runFake = (argv: readonly string[]) => {
    const [bin, ...args] = argv
    if (bin === 'git' && args[0] === 'rev-parse') return { ...ok(null), stdout: 'feature/CORE-2043_md-buildpacks\n' }
    if (bin === 'git') return { ...ok(null), stdout: 'ssh://git@stash.example.com:7999/core/core.git\n' }
    const path = String(args[1] ?? '')
    calls.push(path)
    if (path.includes('role=REVIEWER')) return ok(REVIEW)
    if (path.includes('role=AUTHOR')) return ok(MINE)
    if (path.startsWith('/rest/api/1.0/projects/CORE/repos/core/pull-requests?at=')) {
      expect(path).toContain('state=ALL')
      return ok({ values: MINE.values })
    }
    if (path === '/rest/build-status/1.0/commits/bbb?limit=50') {
      return ok({
        values: [
          { state: 'FAILED', key: 'CI', name: 'Team / Core / CI: On Commit', url: 'https://ci.example.com/1' },
          { state: 'SUCCESSFUL', key: 'Sonar', name: 'Sonar', url: 'https://ci.example.com/2' },
        ],
      })
    }
    if (path === '/rest/api/1.0/projects/CORE/repos/core/pull-requests/912/merge') {
      return ok({ canMerge: false, conflicted: true, outcome: 'CONFLICTED', vetoes: [] })
    }
    if (path === '/rest/api/latest/projects/CORE/repos/core/pull-requests/912/diff-stats-summary') {
      return ok({ filesChanged: 60, totalInsertions: 3698, totalDeletions: 1909 })
    }
    if (path.includes('build-status/1.0/commits/stats')) {
      return ok({
        aaa: { successful: 1, failed: 0, inProgress: 0 },
        bbb: { successful: 0, failed: 1, inProgress: 0 },
      })
    }
    return { ...ok(null), exitCode: 1, stderr: `unexpected ${path}` }
  }
  on('process.run', ($, e) => ({ value: runFake(e.argv) }))
  on('mcp.call', ($, e) => {
    expect(e.server).toBe('atlassian')
    expect(e.tool).toBe('jira_search')
    return { value: { isError: false, content: [{ type: 'text', text: JSON.stringify({ result: JSON.stringify(ISSUES) }) }] } }
  })
  on('ui.status', ($, e) => {
    status = e.text
    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    filled = e.text
    return { isFilled: true }
  })

  await $.session.start({ cwd: '/work/core', surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'jb',
    args: 'refresh',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  expect(status).toBeUndefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'jira-bitbucket',
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 12,
        bodyColumns: 90,
        scroll: { offset: 0, bodyRows: 12 },
        view: {},
      },
    })
    // the bar, folded by default: number, title, approvals, merge state, CI;
    // repo, branch and diff are the app's own bar's
    expect(await band.find({ type: 'Text', text: /^#912$/ })).toBeDefined()
    expect(await band.findAll({ type: 'Text', text: /^Market Data: buildpacks$/ })).toHaveLength(2)
    expect(await band.find({ type: 'Text', text: /^⚠ 1\/2$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^Conflicts$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^core$/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /feature\/CORE-2043_md-buildpacks/ })).toBeUndefined()

    // the card floats, hidden, inside the keyed PR area, whose hover reveals it
    const tree = JSON.stringify(await band.drawn())
    expect(tree).toMatch(/"key":"band-pr".*?"position":"absolute","bottom":1,"left":0,.*?"display":"none".*?\},"hover":\{"display":"flex"\}/)
    // only the icon and number hover: the title sits outside the keyed area
    const prArea = JSON.stringify((await band.find({ key: 'band-pr' }))?.children)
    expect(prArea).toContain('#912')
    expect((prArea.match(/Market Data: buildpacks/g) ?? []).length).toBe(1) // the card's copy alone
    expect(tree).not.toContain('"scope"')
    expect(tree.includes('"type":"Svg"')).toBe(surface === 'desktop')
    if (surface === 'terminal') expect(await band.find({ type: 'Text', text: /^⎇$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^\+3,698$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^−1,909$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^· 60 files$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^CORE\/core #912$/ })).toBeDefined()

    // the status rows are folded until CI is clicked
    expect((await band.find({ key: 'band-toggle' }))?.props.label).toBe('CI ▼')
    expect(await band.find({ key: 'band-details' })).toBeUndefined()

    await band.press({ key: 'band-toggle' })
    expect((await band.find({ key: 'band-toggle' }))?.props.label).toBe('CI ▲')
    expect(await band.find({ type: 'Text', text: /1 of 2 failing · CI: On Commit/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Changes requested by bob/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Conflicts with master/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^CORE-2043 · In Progress · Build images$/ })).toBeDefined()
    expect(JSON.stringify(await band.find({ key: 'band-details' }))).not.toContain('"position"')
    expect(JSON.stringify(await band.find({ key: 'band-details' }))).toContain('https://jira.example.com/browse/CORE-2043')

    await band.press({ key: 'band-fix-checks' })
    expect(filled).toContain('failing builds on its latest commit: CI: On Commit (https://ci.example.com/1)')
    await band.press({ key: 'band-review' })
    expect(filled).toContain('Go through the review on my Bitbucket PR CORE/core#912')
    await band.press({ key: 'band-conflicts' })
    expect(filled).toContain('merge origin/master into this branch')

    // a new session remembers the unfolded bar, then the folded one
    await $.session.start({ cwd: '/work/core', surface, isInteractive: true })
    expect(await band.find({ key: 'band-details' })).toBeDefined()
    await band.press({ key: 'band-toggle' })
    expect(await band.find({ key: 'band-details' })).toBeUndefined()
    await $.session.start({ cwd: '/work/core', surface, isInteractive: true })
    expect(await band.find({ key: 'band-details' })).toBeUndefined()
    await band.unmount()
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'jira-bitbucket',
      surface,
      component: 'Pane',
      requestId: 'jb',
      props: {
        title: 'Jira · Bitbucket',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })
    expect(await ui.find({ type: 'Text', text: /NEEDS MY REVIEW \(1\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /MY OPEN PRS \(1\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /needs work/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /draft/ })).toBeUndefined()

    await ui.press({ key: 'review-SHOP-perf-37-go' })
    expect(filled).toContain('SHOP/perf#37')
    await ui.press({ key: 'mine-CORE-core-912-go' })
    expect(filled).toContain('Check my Bitbucket PR CORE/core#912')
    await ui.unmount()
  }
})
