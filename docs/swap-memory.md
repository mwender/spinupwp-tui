# Swap memory

SpinupWP does not expose a swap-management API. SpinupTUI can inspect and
ensure swap directly over SSH from the server-actions overlay.

Select a server, press `a`, choose **Manage swap**, and enter the requested size
in GiB. The default is calculated from RAM as half the server's memory, rounded
up and clamped to 1–4 GiB; if RAM cannot be read, the default is 2 GiB.

The operation requires a connected sudo session (`S`). After confirmation it:

- leaves active swap devices unchanged unless the active setup is exactly `/swapfile`;
- resizes an active `/swapfile` when a different size is requested, with a
  brief swap-off interval while the replacement is prepared;
- reuses a valid inactive `/swapfile`, when present;
- otherwise creates `/swapfile` with root ownership and mode `0600`;
- enables it immediately; and
- adds one idempotent `/swapfile none swap sw 0 0` entry to `/etc/fstab`.

The app verifies that `/swapfile` is active and persistent before reporting
success. Active swap devices other than a single `/swapfile` are left alone and
cannot be resized by this flow. It does not disable or remove swap. This is a
direct OS change, not a SpinupWP API action.

To verify manually, use `sudo swapon --show` and
`grep -n '/swapfile' /etc/fstab`. To undo it manually, disable the entry with
`sudo swapoff /swapfile`, remove the `/swapfile` line from `/etc/fstab`, and
then remove the file with `sudo rm /swapfile`.
