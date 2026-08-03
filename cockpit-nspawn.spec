Name:           cockpit-nspawn
Version:        0.1.0
Release:        1%{?dist}
Summary:        Cockpit UI for systemd-nspawn containers
License:        LGPL-2.1-or-later
URL:            https://github.com/realmcuser/cockpit-nspawn
Source0:        cockpit-nspawn.tar.gz
BuildArch:      noarch

Requires:       cockpit-bridge >= 300
Requires:       systemd
Requires:       /usr/bin/machinectl
Requires:       rsync

%description
A Cockpit module for managing systemd-nspawn containers via machinectl.
Provides a web interface for listing, starting, stopping, and inspecting
nspawn containers, as well as viewing their journals.

%prep
%setup -q -n cockpit-nspawn

%install
install -d %{buildroot}%{_datadir}/cockpit/nspawn
cp -r * %{buildroot}%{_datadir}/cockpit/nspawn/
rm -rf %{buildroot}%{_datadir}/cockpit/nspawn/pull-backup

# Source-host scripts for pull-backup mode (see PULL-BACKUP-SCRIPT-PACKAGING.md).
# Packaged statically so `dnf update cockpit-nspawn` spreads the latest
# version to every source host this package is installed on, whether or
# not any container has pull-backup enabled yet. BackupDialog.jsx also
# writes these files itself when a container's pull-backup toggle is
# saved, kept as a fallback and to cover any host lacking these RPM files.
install -d %{buildroot}/usr/local/lib/nspawn-pull
install -m755 pull-backup/dispatch.sh pull-backup/pre-snapshot.sh \
    pull-backup/snapshot-db.sh pull-backup/restore-after-backup.sh \
    %{buildroot}/usr/local/lib/nspawn-pull/

%files
%dir %{_datadir}/cockpit/nspawn
%{_datadir}/cockpit/nspawn/*
%dir /usr/local/lib/nspawn-pull
/usr/local/lib/nspawn-pull/dispatch.sh
/usr/local/lib/nspawn-pull/pre-snapshot.sh
/usr/local/lib/nspawn-pull/snapshot-db.sh
/usr/local/lib/nspawn-pull/restore-after-backup.sh

%post
# rrsync ships only as a doc file in the rsync package on most distros -
# symlink/copy it onto $PATH if it's not there yet, same check
# BackupDialog.jsx's installPullSourceHostFiles() already does at runtime.
if ! command -v rrsync >/dev/null 2>&1; then
    if [ -f /usr/share/doc/rsync/support/rrsync ]; then
        install -m755 /usr/share/doc/rsync/support/rrsync /usr/local/bin/rrsync || :
    fi
fi
exit 0

%changelog
* Sat Mar 01 2026 Developer <dev@example.com> - 0.1.0-1
- Initial release
