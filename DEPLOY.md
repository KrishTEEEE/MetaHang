# Deploying FaceHangout

Two pieces, deployed separately:

- **Client** — static Vite build on **GitHub Pages** at `https://krishteee.github.io/Metang/`
- **Relay** — Node WebSocket server on **Fly.io** at `wss://metang-relay.fly.dev`

Pages cannot run the relay: it serves files only, and the relay is a long-lived
process holding sockets. Hence the split.

---

## Relay — already deployed

App `metang-relay`, region `lhr`, one `shared-cpu-1x` 256 MB machine.

**Exactly one machine, deliberately.** Rooms live in process memory
(`rooms` in `server/index.ts`), so a second instance would be a second, separate
set of rooms — two people could join the same room and never see each other. Fly
adds a standby machine by default; that was scaled back to one. If you ever run
`fly scale count` again, keep it at 1 until room state moves out of process.

It idles at near-zero cost: `auto_stop_machines = "stop"` stops the machine when
no sockets remain, and Fly wakes it in ~1-3s on the next connection. Always-on
would be roughly $2/month.

```bash
FLY=./.fly/bin/flyctl     # installed project-local, gitignored

$FLY status                # is it up?
$FLY logs                  # live logs
$FLY deploy --remote-only  # redeploy after changing server/
$FLY machines list         # confirm still exactly 1
```

Smoke-test the live relay any time — this is the real integration test, not a mock:

```bash
RELAY_URL=wss://metang-relay.fly.dev npm run test:relay
```

### Two behaviours specific to running behind Fly's proxy

- **Disconnects take ~5s to register.** A clean close reaches the backend in
  milliseconds on loopback but travels through Fly's proxy in production, so a
  peer who closes their tab lingers for about five seconds. The relay test
  allows for this via `W_CLOSE`; `RELAY_WAIT` overrides it.
- **A heartbeat is required, not optional.** Clients that vanish without a clean
  close (laptop lid, dropped wifi) never send one, and the socket can survive
  indefinitely through the proxy. `server/index.ts` pings every 15s and
  terminates anything that misses a pong, so phantom peers clear within ~30s.

---

## Client — remaining steps

The workflow (`.github/workflows/deploy.yml`) is written and runs on push to
`main`. It typechecks, runs the 128 assertions, builds with `VITE_BASE=/Metang/`,
and publishes `dist/`.

1. **Merge the branch.**
   ```bash
   git checkout main && git merge deploy/pages-and-relay && git push
   ```
2. **Make the repo public** — Pages needs it on a free plan.
   ```bash
   gh repo edit KrishTEEEE/Metang --visibility public --accept-visibility-change-consequences
   ```
3. **Set the relay URL** as a repo variable, so it can change without a code edit:
   ```bash
   gh variable set RELAY_URL --body "wss://metang-relay.fly.dev"
   ```
4. **Enable Pages**: repo Settings → Pages → Source = **GitHub Actions**.
5. Re-run the workflow if it ran before step 3 (`gh run rerun` or push again).

Then open `https://krishteee.github.io/Metang/?room=test` in two browsers.

### Lock the relay down once the URL is known

The relay currently accepts any origin. Once Pages is live:

```bash
./.fly/bin/flyctl secrets set ALLOWED_ORIGIN="https://krishteee.github.io"
```

Leave it unset for local development, where any origin is wanted.

---

## The one risk that could still bite

MediaPipe's threaded wasm can require `SharedArrayBuffer`, which needs COOP/COEP
headers — and **GitHub Pages cannot set custom headers**. This could not be
tested before deploying, because it only manifests on the real host.

If the published site fails at "Loading face model…" with a console error
mentioning `SharedArrayBuffer` or cross-origin isolation, the fix is to serve the
client from **Cloudflare Pages** or **Netlify** instead — both free, both allow
custom headers, and nothing else changes: same build, same relay, same repo.
Only steps 2-4 above are replaced.

---

## Rollback

- Client: revert the merge and push; the workflow republishes the previous build.
- Relay: `./.fly/bin/flyctl releases` then `./.fly/bin/flyctl deploy --image <previous>`.
- Everything off: `./.fly/bin/flyctl apps destroy metang-relay`.
