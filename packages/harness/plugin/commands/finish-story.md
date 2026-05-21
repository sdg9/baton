---
description: After a story branch is merged into base, archive the change folder, remove the worktree, and delete the local branch.
argument-hint: <story-name>
---

The user has merged story `$ARGUMENTS` into the base branch and wants to clean up.

Run:

```sh
npx -y -p @baton-tools/harness@0.2.1 baton-harness finish $ARGUMENTS
```

The command refuses if the branch isn't merged into the base, so it's safe to run reflexively. Report the output (archived path, removed worktree, deleted branch). If it fails because the branch isn't merged, tell the user and stop — do not attempt to merge for them.
