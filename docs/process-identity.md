# Process ownership across hostname changes and restarts

Service wrappers, their children, machine leases and database maintenance owners use a versioned process identity. Version 2 records:

- `machineId`: an application-scoped SHA-256 digest of the OS machine identity (macOS IOPlatformUUID, Linux machine-id). The raw machine identifier is not persisted.
- `bootSessionId`: macOS kern.bootsessionuuid or Linux boot_id. It changes on reboot and does not follow wall-clock corrections.
- `pidNamespace`: the Linux PID namespace, or `host` on macOS.
- PID and observed process start time. Hostname and legacy `bootId` remain diagnostic/compatibility fields.

On the same machine and boot, a hostname change does not alter ownership. A different boot on the same machine proves that the old process has exited, even if its PID has been reused. Within one boot, the PID must still have the same start time. A different machine or PID namespace, malformed identity, future identity version, or unavailable probe returns `unknown`; it is not permission to terminate a process or start a replacement. When stable identity probes are unavailable, creating a new owner fails closed rather than silently emitting hostname-only evidence.

The service manager and the independently spawned wrapper use the same inspector. Launchd reporting a live generation without a matching live wrapper receipt still blocks replacement. Stop only signals a proven live owner; a prior-boot receipt cannot authorize a signal to the process that now owns that PID. Machine lease reclamation and maintenance reentry use the same stable scope, without rewriting old owner records or resetting task state.

## Upgrade and legacy receipts

No database schema change or manual state rewrite is required. A normal stop/start through the upgraded package records v2 identities for the new wrapper, child and leases. Upgrade while the existing receipt can still be verified, then restart before a later hostname change/reboot.

Pre-v2 receipts retain their conservative compatibility rules: the current hostname or matching legacy boot evidence is needed to establish locality. A legacy receipt that has **both** a different hostname and different boot evidence cannot establish which machine it came from. It remains `unknown`; absence of the same PID on this computer is not evidence that a process on another computer has exited. Such an already-stranded legacy installation still needs an explicitly reviewed local-origin recovery before normal startup can replace its receipt. This change does not silently adopt foreign state, add a hostname allowlist, or clear ambiguous runtime/lease records.

A cloned OS installation that also clones its OS machine identity cannot be distinguished by that identifier alone; cross-machine state copying remains subject to project/machine registration checks. Linux PID namespaces are checked separately within a boot. Downgrading to a writer that ignores v2 identity fields is not a supported way to recover a service.

## Verification

Deterministic tests cover rename, reboot, close boot times, wall-clock drift, foreign machines, PID namespaces, PID reuse, process-probe failure, unavailable machine evidence, malformed/future identities and legacy receipts. A machine-coordinator test serializes a lease, retains it across rename and reclaims it after a simulated reboot. A macOS integration test launches the actual wrapper with a serialized renamed prior-boot receipt, verifies its new child reaches ready, then confirms graceful exit before unloading. Launchd is simulated in that test; it does not reboot the machine or run a model.
