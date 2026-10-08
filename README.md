# Jira · Bitbucket mod for Claude Code

A [Claude Code](https://code.claude.com) mod (a plugin of function hooks) that brings your **Bitbucket Data Center** pull requests and their **Jira** issues into Claude Code: in the terminal and in the desktop app's Code tab.

- **`/jb` pane**: the PRs waiting for your review, and your own open PRs. Each one shows build status, approvals, "needs work", conflicts, open tasks, comments and the linked Jira issue's status. One click drafts a *Review with Claude* or *Triage with Claude* prompt.
- **PR bar above the prompt**: the current git branch's PR. It shows the number (hover for a card with author and diff stats), title, approvals, merge state and a CI dot. Click **CI ▼** to unfold the Checks, Reviews, Merge and Jira rows. When something needs doing you also get **Fix failing checks**, **Address review** and **Resolve conflicts** buttons.
- **Read-only by design.** The mod only *reads* Bitbucket and Jira. Every button fills the prompt box with a draft and nothing is sent until you press Enter. Any write (a comment, an approval, a push) goes through Claude's normal permission prompts.
- Refreshes every few minutes, and when you switch branches.

## Requirements

| What | Why |
| --- | --- |
| A recent Claude Code (built on 2.1.293) | Mods (function-hook plugins) |
| [`bkt`](https://github.com/avivsinai/bitbucket-cli), logged in to your Bitbucket Data Center | All Bitbucket reads go through `bkt api`, reusing its stored login |
| *(optional)* [`mcp-atlassian`](https://github.com/sooperset/mcp-atlassian) MCP server connected to Claude Code | Jira issue status and summary. Without it, everything else still works. |
| `git` | Finds the current branch and its Bitbucket repo from `origin` |

### 1. Install and log in to `bkt`

```bash
brew install avivsinai/tap/bitbucket-cli
```

```bash
bkt auth login https://bitbucket.example.com
```

Check that it works:

```bash
bkt api "/rest/api/1.0/dashboard/pull-requests?role=AUTHOR&limit=1"
```

For other platforms, see the [bkt releases](https://github.com/avivsinai/bitbucket-cli/releases). If `bkt` isn't on the `PATH` Claude Code sees, set the **bkt executable** option to its full path. The mod also tries `/opt/homebrew/bin/bkt` and `/usr/local/bin/bkt` on its own.

### 2. *(Optional)* Connect Jira through `mcp-atlassian`

The mod calls the `jira_search` tool of an MCP server named `atlassian`. Add one at user scope. This needs [`uv`](https://docs.astral.sh/uv/) for `uvx`. For Jira Server / Data Center, use a [personal access token](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html):

```bash
claude mcp add atlassian --scope user -e JIRA_URL=https://jira.example.com -e JIRA_PERSONAL_TOKEN=<your-token> -- uvx mcp-atlassian
```

For Jira Cloud, use `-e JIRA_USERNAME=<you@company.com> -e JIRA_API_TOKEN=<api-token>` instead of `JIRA_PERSONAL_TOKEN`. See the [mcp-atlassian docs](https://github.com/sooperset/mcp-atlassian) for the other options.

Your token stays in your own Claude Code MCP config. The mod never sees or stores it.

## Install

In a terminal `claude` session, run:

```
/plugin install jira-bitbucket --marketplace Fyzu/claude-atlassian-mode
```

1. Answer `y` to add the `Fyzu/claude-atlassian-mode` marketplace.
2. Pick a scope. **User** loads the mod in every session, including the desktop app's Code tab.
3. Fill in the options (see below). At least set **Jira URL** if you want issue keys to be links.

You'll see `Installed jira-bitbucket. Plugin is now active.` Then type `/jb`.

> `/plugin` is a terminal command. If you mostly use the desktop app, install once from a terminal at **user** scope and the mod shows up in the app too.

Without the slash command (for example, in a setup script):

```bash
claude plugin marketplace add Fyzu/claude-atlassian-mode
```

```bash
claude plugin install jira-bitbucket@claude-atlassian-mode
```

### Update

```bash
claude plugin marketplace update claude-atlassian-mode
```

```bash
claude plugin update jira-bitbucket@claude-atlassian-mode
```

Then run `/reload-plugins` in an open session, or start a new one.

### Uninstall

```bash
claude plugin uninstall jira-bitbucket@claude-atlassian-mode
```

## Usage

| Command | Does |
| --- | --- |
| `/jb` | Open the pane |
| `/jb refresh` | Refresh now |
| `/jb close` | Close the pane |

In the pane, press `r` (or **Refresh**) to reload. The PR bar above the prompt appears on its own whenever the current branch has an open PR, or one merged or declined within the last 7 days.

## Options

You're asked for these on install. Review or change them later with `claude plugin configure jira-bitbucket@claude-atlassian-mode`.

| Option | Default | Meaning |
| --- | --- | --- |
| `bkt` | `bkt` | Path or name of the `bkt` CLI |
| `jiraServer` | `atlassian` | Name of the connected MCP server that has `jira_search` |
| `jiraUrl` | *(empty)* | Jira base URL for issue links, e.g. `https://jira.example.com`. Empty shows keys without links. |
| `refreshMinutes` | `3` | How often to poll Bitbucket and Jira (1–60) |
| `reviewLimit` | `20` | How many PRs awaiting your review the pane lists (1–100) |
| `openOnStart` | `false` | Open the pane when a session starts |

Jira keys are taken from the PR title (`[ABC-123] …`) or else the branch name (`feature/ABC-123-…`).

## Troubleshooting

- **`Bitbucket: bkt not found`**: set the `bkt` option to the full path (`which bkt`).
- **`Bitbucket: …401…`**: run `bkt auth login <your Bitbucket URL>` again.
- **`Jira: …`** in yellow: the MCP server isn't connected or its name differs. Run `claude mcp list` and set `jiraServer` to match.
- **No PR bar**: the branch has no PR, or `origin` isn't the Bitbucket repo (expects `…/<project>/<repo>.git`).
- Run `claude --debug` to see why a hook was skipped.

## Development

```
.claude-plugin/
  plugin.json        manifest and user options
  marketplace.json   makes this repo installable with /plugin install
hooks/
  hooks.json         points at the hooks module
  register.tsx       the mod
  register.test.tsx  engine test (pane, PR bar, buttons) with faked bkt/git/Jira
types/index.d.ts     state contract ($.state values)
tsconfig.json        extends the typings Claude Code writes on load
```

To run your working copy instead of the installed one, start a session with the folder loaded. Edits hot-reload.

```bash
claude --plugin-dir /path/to/claude-atlassian-mode
```

For the desktop app, add the folder to `~/.claude/settings.json` instead:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-atlassian-mode" } }
```

Check and test:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

Claude Code writes its API typings to `.claude-plugin/types/` (gitignored) the first time it loads the mod. After that you can type-check:

```bash
npx -p typescript tsc -p .
```

## License

[MIT](LICENSE)
