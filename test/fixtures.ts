// Screens captured from Claude Code 2.1.296 running in tmux during development.

export const TRUST_SCREEN = `────────────────────────────────────────────
 Accessing workspace:
 /private/tmp/spike/repo
 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this
 folder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`

export const TRUST_SCREEN_YES = TRUST_SCREEN.replace(' ❯ No, exit', '   No, exit').replace('   Yes, I trust', ' ❯ Yes, I trust')

export const PLAN_SCREEN = `❯ Create a file hello.txt containing the word hi. Keep the plan to one line.
⏺ Updated plan
  ⎿  /plan to preview
────────────────────────────────────────────
 Ready to code?
 Here is Claude's plan:
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Create hello.txt in the repo root containing the word "hi".
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
────────────────────────────────────────────
 Claude has written up a plan and is ready to execute. Would you like to proceed?
 ❯ 1. Yes, and use auto mode
   2. Yes, manually approve edits
   3. Tell Claude what to change
      shift+tab to approve with this feedback
 ctrl+g to edit in VS Code · ~/.claude/plans/create-a-file-hello-txt-dreamy-bunny.md`
