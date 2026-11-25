# Workspace resource catalog

The existing Telegram hub owns a read-only resource service on its private Unix socket. No second daemon or network listener is started. `resources/list` returns configured sites and observed Console worktree records. It never invokes lifecycle hooks or allocates resources.

The owner registers projects in `~/.config/agent-workspace/resources.json`:

```json
{
  "version": 1,
  "projects": [
    {
      "id": "console",
      "root": "/home/user/projects/agentek-console",
      "adapter": "console-wt",
      "statePath": "/home/user/.config/wt/state.json"
    },
    {
      "id": "sites",
      "root": "/home/user/projects/homelab",
      "adapter": "sites",
      "sites": [{ "id": "docs", "name": "Documentation", "url": "https://example.com" }]
    }
  ]
}
```

`console-wt` reads the existing registry and projects only entries lexically within its registered project root. Browser addresses come from that project's `EXTERNAL_STAND_URL_TEMPLATE`; loopback URLs remain internal. No HTTP requests are made to configured sites. `workspace-present` means only that the directory exists, not that its application is healthy.

The protocol accepts only `{ "op": "resources", "id": 1, "action": "list" }`. Registered runtime and native-session connections cannot use this operator surface. The socket's existing current-user filesystem permissions remain its local trust boundary. Do not expose it directly to a network.

```bash
bun src/resources/cli.ts
```

The CLI and DSH bridge share `client.ts`. DSH adds its own authenticated request boundary before accessing the socket. Configuration errors fail the operation; unavailable individual project sources produce safe warning codes without exposing file contents.
