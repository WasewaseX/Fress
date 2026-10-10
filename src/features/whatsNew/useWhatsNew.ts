// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { useEffect, useState } from 'react';

import pkg from '../../../package.json';

/**
 * "What's new": opens once per version, and only for returning users.
 * A fresh install stays silent. Returning users upgrading from versions
 * that never recorded a seen-version still get the release summary once.
 *
 * Read-only probe of the favorites/custom-apps storage (same keys the
 * catalog hook owns) to recognize a returning user.
 */
export function useWhatsNew(): { showWhatsNew: boolean; setShowWhatsNew: (open: boolean) => void } {
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  useEffect(() => {
    try {
      const returning = !!(
        localStorage.getItem('fress_favorites') ||
        localStorage.getItem('fress_custom_items') ||
        localStorage.getItem('fress.seen_version')
      );
      const seen = localStorage.getItem('fress.seen_version');
      if (returning && seen !== pkg.version) setShowWhatsNew(true);
      localStorage.setItem('fress.seen_version', pkg.version);
    } catch {
      // ignore
    }
  }, []);

  return { showWhatsNew, setShowWhatsNew };
}
