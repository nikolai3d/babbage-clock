# babbage-clock

A web-based 3D HTML clock / countdown.

## Task tracking

Issues are tracked with [beads](https://github.com/steveyegge/beads) (`bd`),
backed by a Dolt database in `.beads/`. Sync happens via the Dolt remote
(`bd sync`), not via git hooks — the database itself is not committed to git.
