export type JbBuild = { ok: number; failed: number; running: number }

export type JbIssue = { key: string; summary: string; status: string; category: string }

export type JbReviewer = { name: string; status: string }

export type JbPr = {
  id: number
  project: string
  repo: string
  title: string
  url: string
  sha: string
  fromBranch: string
  toBranch: string
  author: string
  updated: number
  isDraft: boolean
  reviewers: JbReviewer[]
  comments: number
  openTasks: number
  isConflicted: boolean
  build: JbBuild | null
  issueKey: string | null
}

export type JbCheck = { name: string; state: 'ok' | 'failed' | 'running'; url: string }

export type JbMerge = { canMerge: boolean; isConflicted: boolean; vetoes: string[] }

export type JbDiff = { files: number; added: number; removed: number }

export type JbPrDetail = {
  state: 'OPEN' | 'DRAFT' | 'MERGED' | 'DECLINED'
  checks: JbCheck[]
  merge: JbMerge | null
  diff: JbDiff | null
}

export type JbBranch = {
  name: string
  project: string | null
  repo: string | null
  issueKey: string | null
  pr: JbPr | null
  detail: JbPrDetail | null
}

export type JbSnapshot = {
  updatedAt: number
  isLoading: boolean
  error: string | null
  jiraError: string | null
  review: JbPr[]
  reviewHasMore: boolean
  mine: JbPr[]
  issues: Record<string, JbIssue>
  branch: JbBranch | null
}

declare module 'claude-code' {
  interface PluginState {
    'jira-bitbucket': {
      snapshot: JbSnapshot
      /** The PR bar shows its line alone, the status rows folded; kept across sessions in $.store */
      isBarCollapsed: boolean
    }
  }
}
