# twitter-api-safe-archive-delete

`twitter-api-safe-archive-delete` removes every post recorded in an extracted X data archive. Authentication is performed manually in a dedicated persistent browser profile before the deletion command runs.

## Command flow

Use the commands from the workspace root:

```sh
# 1. Open the persistent profile and sign in manually.
pnpm archive:login --profile account1

# 2. Inspect the archive and current progress without opening X.
pnpm archive:inspect --archive ./my_archive

# 3. Delete unresolved posts and verify that their outer IDs are absent.
pnpm archive:delete --archive ./my_archive --profile account1

# 4. Inspect saved progress at any time.
pnpm archive:status --archive ./my_archive
```

The `login` command closes the browser after it confirms the signed-in account. The `delete` command reopens the same profile and does not pause for manual login. If the session has expired, run `login` again.

The deletion command compares the immutable X account ID from the archive with the live signed-in account. A username change does not prevent a valid match.

## Deletion behavior

Normal posts are sent to `DeleteTweet`. For reposts, the tool looks up the outer repost ID, removes an active repost relationship when necessary, and then sends the outer ID to `DeleteTweet`. A repost is complete only when that outer ID can no longer be retrieved.

Each API operation has two attempts by default. A post that still fails is saved as unresolved and processing continues with the next post. Running `delete` again resumes only unresolved work.

Requests are spaced randomly from 1,050 to 1,350 milliseconds. Successful mutations are also limited by conservative rolling windows:

- 200 successful `DeleteTweet` operations per 15 minutes
- 450 successful mutation operations per 60 minutes

The command waits until a slot becomes available. A restriction-like failure starts an adaptive recovery interval, which is persisted beside the progress log.

## Verification and propagation delay

Deletion is followed by an outer-ID lookup. If an ID is still visible, the tool waits 60 seconds and checks it again by default. This separates propagation delay from a genuine deletion failure.

Run a read-only retry without mutation requests with:

```sh
pnpm archive:verify --archive ./my_archive --profile account1
```

Change verification behavior when necessary:

```txt
--propagation-wait-ms <milliseconds>  Delay between verification passes
--verification-rounds <count>         Maximum verification passes
--no-verify                           Skip verification after deletion
```

## Selection and recovery options

```txt
--only-reposts        Select reposts only
--only-posts          Select non-repost posts only
--post-id <id>        Select one archived post ID
--state <file>        Override the progress log path
--max-attempts <n>    Maximum attempts for one API operation (default: 2)
--yes                 Skip the exact destructive confirmation
```

The default progress path is `.archive-delete/<account-id>.ndjson`. It is append-only and compatible with progress created by the earlier workspace command. Legacy repost completion records are reopened when they do not contain proof that the outer repost ID was absent.

## Browser profile

The commands use a profile from `settings.json`. A launch profile must use a dedicated `userDataDir`. Do not run another relay or browser process with the same directory while a command is active.

Authentication cookies remain in the browser profile. The progress log contains account IDs, post IDs, timestamps, post kinds, attempts, and results; it does not contain post text, cookies, or authentication tokens.

The current X Web API operation catalog is loaded at command startup. Use `--catalog <url-or-file>` to supply a pinned local catalog when reproducibility is required.
