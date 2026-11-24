# OpenSSH fixtures

Bob's keypair is generated per run into `generated-keys/` (git-ignored) by the first `ssh-it` command; no key is committed.

From the repository root, run `bun scripts/test-changed.ts --group ssh-it` on Linux with Docker Compose, Xvfb and a built frontend. The runner starts the fixtures, runs the ignored Rust integration tests and tears down Compose.

The fixture limits SCP bandwidth for `slow-copy.bin` so the cancellation test can observe a partially written file before cancelling.
