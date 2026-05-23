#!/bin/sh
# Post-install maintainer script for the deb / rpm packages. Creates a
# `/usr/bin/tedi` symlink to the GUI binary so users can run `tedi` from any
# shell. Without this, `apt install tedi_*.deb` only exposes the binary as
# its renamed-via-mainBinaryName form (`TEDIApp`) — which is correct for the
# .desktop entry but surprises terminal users who expect lowercase `tedi`.
#
# The Windows installer (NSIS) ships a separate console-subsystem launcher
# at `tedi.exe`; on Linux the GUI binary inherits stdio natively from the
# spawning shell, so a simple symlink does the job.
#
# `dpkg` / `rpm` set $1 to "configure" (deb) or a numeric argument (rpm) on
# install / upgrade; either way we just want the link to exist. `ln -sf`
# silently replaces a stale link from a prior install — never errors and
# never accumulates stale entries.

set -e

if [ -x /usr/bin/TEDIApp ]; then
  ln -sf TEDIApp /usr/bin/tedi
fi

exit 0
