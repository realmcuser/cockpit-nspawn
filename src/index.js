/* SPDX-License-Identifier: LGPL-2.1-or-later */

import 'patternfly/patternfly-6-cockpit.scss';
import './style.scss';

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Application } from './app.jsx';

document.addEventListener('DOMContentLoaded', () => {
    createRoot(document.getElementById('app')).render(<Application />);
});
