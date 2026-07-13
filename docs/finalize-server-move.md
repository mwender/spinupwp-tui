# Finalize a server move

The finalize workflow is for the last step of a migration where the destination
server and matching sites already exist. It does not assume a cloud provider:
AWS, Lightsail, Hetzner, and manual DNS/provider cutovers all use the same DB
sync and verification path.

Open it from a server row with `F`.

## Flow

1. Pick the destination server from SpinupWP's server list.
2. SpinupTUI matches source and destination sites by primary domain.
3. Connect sudo on both servers.
4. Select the WordPress sites to finalize.
5. Run the final DB sync.
6. Complete cutover by DNS, provider IP reassignment, or your provider console.

When final sync starts, Finalize also writes a sanitized backup handoff manifest to
`~/Documents/SpinupWP TUI/backup-snapshots/` for the selected sites. This records the
backup information available from the public API without exporting any credentials;
it is intended as input to a separate backup-configuration tool.

For each selected site, SpinupTUI activates maintenance mode on the source,
exports a clean SQL dump outside the web root, imports it into the destination
site's configured database, flushes cache when available, disables destination
maintenance mode, and verifies the destination with WP-CLI.

If a site fails before cutover, the workflow aborts and rolls source
maintenance mode back for that failed site. It never changes DNS or provider
state.

## Test sync without maintenance

On Finalize's **Connect** step, press **`m`** to turn source maintenance off, then
run the sync normally. This leaves the source site public so you can test the
destination, but it is deliberately not a cutover-safe final sync: source writes
can occur after its database snapshot is exported. Re-run Finalize with maintenance
on immediately before moving DNS or an elastic/floating IP.

## Stale database report

After successful imports, the destination server's MySQL databases are compared
against the destination databases discovered during import. System schemas are
ignored. Possible stale databases are reported only; SpinupTUI does not delete
databases.

## Provider scope

The first version intentionally keeps provider-specific IP reassignment out of
the workflow. Use the cutover screen as the handoff point for:

- DNS record updates through the existing DNS tools
- manual provider-console changes
- later provider adapters for movable IPs
