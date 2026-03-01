Name:           cockpit-nspawn
Version:        0.1.0
Release:        1%{?dist}
Summary:        Cockpit UI for systemd-nspawn containers
License:        LGPL-2.1-or-later
URL:            https://github.com/YOURNAME/cockpit-nspawn
Source0:        cockpit-nspawn.tar.gz
BuildArch:      noarch

Requires:       cockpit-bridge >= 300
Requires:       systemd
Requires:       /usr/bin/machinectl

%description
A Cockpit module for managing systemd-nspawn containers via machinectl.
Provides a web interface for listing, starting, stopping, and inspecting
nspawn containers, as well as viewing their journals.

%prep
%setup -q -n cockpit-nspawn

%install
install -d %{buildroot}%{_datadir}/cockpit/nspawn
cp -r * %{buildroot}%{_datadir}/cockpit/nspawn/

%files
%dir %{_datadir}/cockpit/nspawn
%{_datadir}/cockpit/nspawn/*

%changelog
* Sat Mar 01 2026 Developer <dev@example.com> - 0.1.0-1
- Initial release
