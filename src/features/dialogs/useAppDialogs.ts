// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { useState } from 'react';

import { AppItem } from '../../types';
import { LegalTab } from '../../components/LegalModals';

/**
 * Dialog orchestration state for the whole shell: which modal is open,
 * which app it is about, and the shared Escape behavior.
 *
 * This hook deliberately owns NO domain data - only open/closed flags and
 * the app being viewed/edited. Domain logic lives in the feature hooks;
 * the composition layer wires them together.
 */

export type AddFlow = 'search' | 'manual';

export interface AppDialogs {
  /** The app shown in the detail modal. */
  selectedApp: AppItem | null;
  openDetail: (app: AppItem) => void;
  closeDetail: () => void;
  /** Close the detail modal only if it is showing this app (delete path). */
  closeDetailIfApp: (appId: string) => void;

  /** The app being edited in the add/update modal. */
  editingApp: AppItem | null;
  setEditingApp: (app: AppItem | null) => void;

  /** The shared add flow: 'search' (GitHub) or 'manual' (form). */
  addFlow: AddFlow | null;
  setAddFlow: (flow: AddFlow | null) => void;

  /** Legacy open flag for the add modal (edit path reuses it). */
  isAddModalOpen: boolean;
  setIsAddModalOpen: (open: boolean) => void;

  isTauriModalOpen: boolean;
  setIsTauriModalOpen: (open: boolean) => void;

  isShortcutsModalOpen: boolean;
  setIsShortcutsModalOpen: (open: boolean) => void;

  isCommandPaletteOpen: boolean;
  setIsCommandPaletteOpen: (open: boolean | ((prev: boolean) => boolean)) => void;

  isBatchInstallModalOpen: boolean;
  setIsBatchInstallModalOpen: (open: boolean | ((prev: boolean) => boolean)) => void;

  isCompareModalOpen: boolean;
  setIsCompareModalOpen: (open: boolean | ((prev: boolean) => boolean)) => void;

  isExportModalOpen: boolean;
  setIsExportModalOpen: (open: boolean | ((prev: boolean) => boolean)) => void;

  isDownloadsOpen: boolean;
  setIsDownloadsOpen: (open: boolean) => void;

  legalModal: { isOpen: boolean; tab: LegalTab };
  openLegal: (tab: LegalTab) => void;
  closeLegal: () => void;

  /** The Escape handler's behavior: close every transient surface. */
  closeAllDialogs: () => void;
}

export function useAppDialogs(): AppDialogs {
  const [selectedApp, setSelectedApp] = useState<AppItem | null>(null);
  const [editingApp, setEditingApp] = useState<AppItem | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isTauriModalOpen, setIsTauriModalOpen] = useState(false);
  const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isBatchInstallModalOpen, setIsBatchInstallModalOpen] = useState(false);
  const [isCompareModalOpen, setIsCompareModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isDownloadsOpen, setIsDownloadsOpen] = useState(false);
  // One shared add-flow: 'search' (GitHub) or 'manual' (form). A single header
  // button opens it; the tabs inside switch between the two methods.
  const [addFlow, setAddFlow] = useState<AddFlow | null>(null);
  const [legalModal, setLegalModal] = useState<{ isOpen: boolean; tab: LegalTab }>({
    isOpen: false,
    tab: 'privacy'
  });

  const closeAllDialogs = () => {
    setSelectedApp(null);
    setEditingApp(null);
    setIsAddModalOpen(false);
    setIsTauriModalOpen(false);
    setIsShortcutsModalOpen(false);
    setIsCommandPaletteOpen(false);
    setIsBatchInstallModalOpen(false);
    setIsCompareModalOpen(false);
    setIsExportModalOpen(false);
    setAddFlow(null);
    setIsDownloadsOpen(false);
    setLegalModal((prev) => ({ ...prev, isOpen: false }));
  };

  const closeDetailIfApp = (appId: string) => {
    if (selectedApp?.id === appId) {
      setSelectedApp(null);
    }
  };

  return {
    selectedApp,
    openDetail: setSelectedApp,
    closeDetail: () => setSelectedApp(null),
    closeDetailIfApp,

    editingApp,
    setEditingApp,

    addFlow,
    setAddFlow,

    isAddModalOpen,
    setIsAddModalOpen,

    isTauriModalOpen,
    setIsTauriModalOpen,

    isShortcutsModalOpen,
    setIsShortcutsModalOpen,

    isCommandPaletteOpen,
    setIsCommandPaletteOpen,

    isBatchInstallModalOpen,
    setIsBatchInstallModalOpen,

    isCompareModalOpen,
    setIsCompareModalOpen,

    isExportModalOpen,
    setIsExportModalOpen,

    isDownloadsOpen,
    setIsDownloadsOpen,

    legalModal,
    openLegal: (tab) => setLegalModal({ isOpen: true, tab }),
    closeLegal: () => setLegalModal((prev) => ({ ...prev, isOpen: false })),

    closeAllDialogs,
  };
}
