# Orca Cloud with Freestyle resource pools

Choose **Orca Cloud** under **Run on** in the new workspace composer. Each cloud thread is an Orca workspace on its own VM. Starting another agent from the tab bar of a cloud workspace opens the composer with the same cloud recipe. Reopen a thread to return to its existing VM. **Sleep** pauses the VM, **Wake** resumes it, and deleting the workspace removes its VM and ingress rule.

Thread VMs share one Freestyle resource pool. Prepared projects boot a snapshot containing their Git checkout and the installed Orca runtime. The recipe has no VM count limit of its own. Freestyle still enforces VM counts, admission floors and the pool's CPU, resident memory and storage budgets. The experimental pool and its file system live on one manager.

## Configure a canary

You need Node.js 22+ on the desktop's PATH, an allowlisted Freestyle account, and a canary manager with a staged virtiofs root and nightly build. The root must include Git, a compatible Linux Orca CLI (`orca-ide` with `serve --recipe-json`), Xvfb for the Linux display, and any agent tools you want to use. The base must have no running Orca server or copied Orca runtime state. Git access and agent sign-in are configured separately.

From the Orca checkout, with the canary account's `FREESTYLE_API_KEY` exported, create a pool. The sizes are vCPUs, memory MiB and storage MiB.

```sh
node config/scripts/freestyle-cloud/cli.mjs pool-create CANARY_MANAGER_ID 4 4096 16384
```

Export the returned pool ID as `FREESTYLE_ORCA_POOL_ID`, then build the shared template from the base ID staged on that manager.

```sh
node config/scripts/freestyle-cloud/cli.mjs template-create STAGED_BASE_ID 2 2048 4096
```

This starts a bootstrap VM, captures the prepared snapshot and removes the bootstrap. It prints the snapshot ID. If the canary already has a prepared Orca snapshot in this pool, use its ID and skip this step. [Freestyle file-COW canary procedure](https://github.com/freestyle-sh/freestyle-vms/blob/main/docs/file-cow-manager-experiment.md#authenticated-undocumented-api)

Set these values in the environment of the Orca desktop process or in `~/.orca/freestyle-cloud.env`. On macOS and Linux the file must be mode `0600`.

```dotenv
FREESTYLE_API_KEY=your-canary-account-key
FREESTYLE_ORCA_POOL_ID=pool-...
FREESTYLE_ORCA_SNAPSHOT_ID=sh-...
```

```sh
node config/scripts/freestyle-cloud/cli.mjs doctor
```

Doctor checks that the API key can read the configured pool and snapshot. A live create verifies that the snapshot belongs to the pool, starts the guest, and returns an Orca pairing link. The recipe uses an authenticated Orca WebSocket behind a unique `style.dev` TLS rule. To use a verified wildcard domain instead, set `FREESTYLE_ORCA_DOMAIN_SUFFIX` to its suffix without `*.`. Keep the pairing link private.

## Prepare a Git project

Run this once from the project's local checkout after fetching `origin`. The snapshot contains committed origin tracking refs and Orca's verified runtime and compile cache. Orca picks the snapshot by pool, base image, and Git origin. Each thread forks the snapshot, starts its own Orca server, and fetches recent changes in parallel. The thread can create its worktree once both are ready.

```sh
git fetch --prune origin
node /path/to/orca/config/scripts/freestyle-cloud/cli.mjs project-prepare
```

For a private GitHub repository, add a dedicated [deploy key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys) to the repository. Use write access if threads need to push. Keep the private key at `~/.orca/freestyle-cloud/keys/github.com--owner--repo`, with lowercase owner and repo names and file mode `0600` on Unix. Orca installs this key only in VMs for that repository after they boot. Git credentials and Orca pairing state are absent from the prepared snapshot.

For unprepared projects, Orca fetches the initial checkout directly from the remote at launch. Sign in to your agent separately through Orca's remote account settings.

## Demo

1. Add a local Git project in an Orca build from this branch and enable **Cloud VM** in **Settings → Experimental**.
2. Create two workspaces with **Run on → Orca Cloud** and start an agent in each. The setup log shows the distinct VM IDs and their common pool ID.
3. Write a file outside the repo in one thread's terminal and check that the other thread cannot see it. Sleep and wake the first workspace, then check its file and agent state.
4. Delete both workspaces. Keep the shared pool and snapshot to start more threads. To retire the pool, delete its template snapshots as well, then run `node config/scripts/freestyle-cloud/cli.mjs pool-delete POOL_ID`.
