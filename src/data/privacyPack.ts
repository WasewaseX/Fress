// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * The data behind the "Replace your apps for better privacy" tab.
 *
 * Ported from ente's PrivacyPack (github.com/ente-io/privacypack, MIT),
 * data/apps.json, with two additions Fress needs:
 *  - every private alternative carries a security grade for the Fress threat
 *    model (default protection against governments and hackers), because a
 *    flat list of options with different guarantees confuses new users;
 *  - alternatives that exist in the Fress catalog carry a catalogId, so they
 *    plug straight into the download engine and the app detail modal.
 *
 * Levels:
 *  3  Fortress: encrypted or local by default, open source. Even the operator,
 *     a subpoena or an attacker on the network gets nothing readable.
 *  2  Strong: open source and privacy-respecting, but some metadata or trust
 *     in the operator remains.
 *  1  Basic: a real step up from the mainstream app, but closed source or
 *     weaker defaults. Fine as a first move.
 */

export type PpLevel = 1 | 2 | 3;

export interface PpApp {
  id: string;
  name: string;
}

export interface PpAlternative {
  id: string;
  name: string;
  level: PpLevel;
  /** Set when this option is a vetted catalog app: downloads and detail modal work. */
  catalogId?: string;
}

export interface PpCategory {
  id: string;
  name: string;
  order: number;
  mainstream: PpApp[];
  alternatives: PpAlternative[];
  /** The "Start here" alternative id: the sane first move for a new user. */
  pick: string;
}

export const PP_LEVEL_INFO: Record<PpLevel, { label: string; blurb: string; chip: string; dot: string }> = {
  1: {
    label: 'Basic',
    blurb: 'A real step up from the mainstream app, but closed source or weaker defaults. Fine as a first move.',
    chip: 'bg-amber-500/15 text-amber-500 dark:text-amber-400',
    dot: 'bg-amber-400',
  },
  2: {
    label: 'Strong',
    blurb: 'Open source and privacy-respecting, but some metadata or trust in the operator remains.',
    chip: 'bg-sky-500/15 text-sky-500 dark:text-sky-400',
    dot: 'bg-sky-400',
  },
  3: {
    label: 'Fortress',
    blurb: 'Encrypted or local by default, open source. Even the operator, a subpoena or an attacker on the network gets nothing readable.',
    chip: 'bg-emerald-500/15 text-emerald-500 dark:text-emerald-400',
    dot: 'bg-emerald-400',
  },
};

export const PP_SOURCE_URL = 'https://github.com/ente-io/privacypack';

export const PRIVACY_PACK: PpCategory[] = [
  {
    id: 'mail', name: 'Mail', order: 1,
    mainstream: [{ id: 'gmail', name: 'Gmail' }, { id: 'outlook', name: 'Outlook' }, { id: 'yahoo_mail', name: 'Yahoo Mail' }, { id: 'icloud_mail', name: 'iCloud Mail' }],
    alternatives: [
      { id: 'proton_mail', name: 'Proton Mail', level: 3, catalogId: 'proton-mail' },
      { id: 'tuta_mail', name: 'Tuta Mail', level: 3, catalogId: 'tuta' },
      { id: 'disroot_webmail', name: 'Disroot webmail', level: 2 },
      { id: 'forwardemail_net', name: 'Forward Email', level: 2 },
      { id: 'posteo', name: 'Posteo', level: 2 },
      { id: 'runbox', name: 'Runbox', level: 2 },
      { id: 'startmail', name: 'StartMail', level: 2 },
      { id: 'mailbox', name: 'mailbox.org', level: 2 },
      { id: 'migadu', name: 'Migadu', level: 1 },
      { id: 'murena_workspace', name: 'Murena Email', level: 1 }
    ],
    pick: 'tuta_mail',
  },
  {
    id: 'photos', name: 'Photos', order: 2,
    mainstream: [{ id: 'google_photos', name: 'Google Photos' }, { id: 'apple_photos', name: 'Apple Photos' }, { id: 'amazon_photos', name: 'Amazon Photos' }, { id: 'dropbox', name: 'Dropbox' }],
    alternatives: [
      { id: 'ente_photos', name: 'Ente Photos', level: 3, catalogId: 'ente-photos' },
      { id: 'filen', name: 'Filen', level: 3 },
      { id: 'fossify_gallery', name: 'Fossify Gallery', level: 3, catalogId: 'fossify-gallery' },
      { id: 'immich', name: 'Immich', level: 3, catalogId: 'immich' },
      { id: 'proton_drive', name: 'Proton Drive', level: 3 },
      { id: 'nextcloud_memories', name: 'Nextcloud Memories', level: 2, catalogId: 'nextcloud' },
      { id: 'photoprism', name: 'PhotoPrism', level: 2 },
      { id: 'zeitkapsl', name: 'zeitkapsl', level: 2 },
      { id: 'apple_photos', name: 'Apple Photos', level: 1 },
      { id: 'jottacloud', name: 'Jottacloud', level: 1 },
      { id: 'murena_workspace', name: 'Murena Gallery', level: 1 }
    ],
    pick: 'ente_photos',
  },
  {
    id: 'search', name: 'Search', order: 3,
    mainstream: [{ id: 'google_search', name: 'Google Search' }, { id: 'bing', name: 'Bing' }],
    alternatives: [
      { id: 'searxng', name: 'SearXNG', level: 3, catalogId: 'searxng' },
      { id: 'brave_search', name: 'Brave Search', level: 2 },
      { id: 'duckduckgo', name: 'DuckDuckGo', level: 2 },
      { id: 'mojeek', name: 'Mojeek', level: 2 },
      { id: 'qwant', name: 'Qwant', level: 2 },
      { id: 'startpage', name: 'Startpage', level: 2 },
      { id: 'kagi', name: 'Kagi', level: 1 },
      { id: 'murena_find', name: 'Murena Find', level: 1 },
      { id: 'prieco', name: 'PriEco', level: 1 }
    ],
    pick: 'searxng',
  },
  {
    id: 'browser', name: 'Browser', order: 4,
    mainstream: [{ id: 'chrome', name: 'Chrome' }, { id: 'safari', name: 'Safari' }, { id: 'edge', name: 'Edge' }, { id: 'opera', name: 'Opera' }],
    alternatives: [
      { id: 'librewolf', name: 'LibreWolf', level: 3, catalogId: 'librewolf' },
      { id: 'tor', name: 'Tor', level: 3, catalogId: 'tor-browser' },
      { id: 'brave', name: 'Brave', level: 2 },
      { id: 'cromite', name: 'Cromite', level: 2 },
      { id: 'duckduckgo', name: 'DuckDuckGo Browser', level: 2 },
      { id: 'floorp', name: 'Floorp', level: 2 },
      { id: 'helium', name: 'Helium', level: 2 },
      { id: 'ironfox', name: 'IronFox', level: 2 },
      { id: 'mullvad_browser', name: 'Mullvad Browser', level: 2 },
      { id: 'trivalent', name: 'Trivalent', level: 2 },
      { id: 'vanadium', name: 'Vanadium', level: 2 },
      { id: 'waterfox', name: 'Waterfox', level: 2 },
      { id: 'zen_browser', name: 'Zen Browser', level: 2 },
      { id: 'firefox', name: 'Firefox', level: 1 },
      { id: 'orion', name: 'Orion', level: 1 },
      { id: 'vivaldi', name: 'Vivaldi', level: 1 }
    ],
    pick: 'librewolf',
  },
  {
    id: 'messaging', name: 'Messaging', order: 5,
    mainstream: [{ id: 'whatsapp', name: 'WhatsApp' }, { id: 'messenger', name: 'Messenger' }, { id: 'telegram', name: 'Telegram' }, { id: 'imessage', name: 'iMessage' }, { id: 'google_messages', name: 'Google Messages' }, { id: 'google_chat', name: 'Google Chat' }],
    alternatives: [
      { id: 'briar', name: 'Briar', level: 3 },
      { id: 'molly', name: 'Molly', level: 3 },
      { id: 'signal', name: 'Signal', level: 3, catalogId: 'signal' },
      { id: 'simplex_chat', name: 'SimpleX Chat', level: 3, catalogId: 'simplex' },
      { id: 'delta_chat', name: 'Delta Chat', level: 2 },
      { id: 'dino', name: 'Dino', level: 2 },
      { id: 'fossify_messages', name: 'Fossify Messages', level: 2 },
      { id: 'rocket_chat', name: 'Rocket.Chat', level: 2 },
      { id: 'session', name: 'Session', level: 2 },
      { id: 'threema', name: 'Threema', level: 2 },
      { id: 'imessage', name: 'iMessage', level: 1 }
    ],
    pick: 'signal',
  },
  {
    id: 'notes', name: 'Notes', order: 6,
    mainstream: [{ id: 'google_keep', name: 'Google Keep' }, { id: 'apple_notes', name: 'Apple Notes' }, { id: 'evernote', name: 'Evernote' }, { id: 'notion', name: 'Notion' }],
    alternatives: [
      { id: 'anytype', name: 'Anytype', level: 3 },
      { id: 'fossify_notes', name: 'Fossify Notes', level: 3 },
      { id: 'notesnook', name: 'Notesnook', level: 3 },
      { id: 'standard_notes', name: 'Standard Notes', level: 3 },
      { id: 'fileverse', name: 'DDocs.new', level: 2 },
      { id: 'joplin', name: 'Joplin', level: 2, catalogId: 'joplin' },
      { id: 'logseq', name: 'Logseq', level: 2 },
      { id: 'memos', name: 'Memos', level: 2 },
      { id: 'obsidian', name: 'Obsidian', level: 2, catalogId: 'obsidian' },
      { id: 'qownnotes', name: 'QOwnNotes', level: 2 },
      { id: 'signal', name: 'Signal Note to Self', level: 2, catalogId: 'signal' },
      { id: 'murena_workspace', name: 'Murena Notes', level: 1 },
      { id: 'nextcloud_notes', name: 'Nextcloud Notes', level: 1 }
    ],
    pick: 'joplin',
  },
  {
    id: 'drive', name: 'Drive', order: 7,
    mainstream: [{ id: 'google_drive', name: 'Google Drive' }, { id: 'onedrive', name: 'OneDrive' }, { id: 'dropbox', name: 'Dropbox' }, { id: 'icloud', name: 'iCloud' }],
    alternatives: [
      { id: 'cryptomator', name: 'Cryptomator', level: 3, catalogId: 'cryptomator' },
      { id: 'ente_locker', name: 'Ente Locker', level: 3 },
      { id: 'filen', name: 'Filen', level: 3 },
      { id: 'proton_drive', name: 'Proton Drive', level: 3 },
      { id: 'syncthing', name: 'Syncthing', level: 3, catalogId: 'syncthing' },
      { id: 'tuta_drive', name: 'Tuta Drive', level: 3 },
      { id: 'fileverse', name: 'Fileverse', level: 2 },
      { id: 'nextcloud', name: 'Nextcloud', level: 2, catalogId: 'nextcloud' },
      { id: 'mailbox', name: 'mailbox.org', level: 2 },
      { id: 'ik-kdrive', name: 'Infomaniak kDrive', level: 1 },
      { id: 'jottacloud', name: 'Jottacloud', level: 1 },
      { id: 'murena_workspace', name: 'Murena Workspace', level: 1 },
      { id: 'tresorit', name: 'Tresorit', level: 1 },
      { id: 'icloud', name: 'iCloud', level: 1 },
      { id: 'pcloud', name: 'pCloud', level: 1 }
    ],
    pick: 'cryptomator',
  },
  {
    id: 'password-managers', name: 'Password Managers', order: 8,
    mainstream: [{ id: 'google_passwords', name: 'Google Passwords' }, { id: 'samsung_pass', name: 'Samsung Pass' }, { id: 'lastpass', name: 'LastPass' }, { id: 'apple_passwords', name: 'Apple Passwords' }, { id: 'nordpass', name: 'NordPass' }, { id: 'dashlane', name: 'Dashlane' }],
    alternatives: [
      { id: 'bitwarden', name: 'Bitwarden', level: 3, catalogId: 'bitwarden' },
      { id: 'keepass', name: 'KeePass', level: 3 },
      { id: 'keepassxc', name: 'KeePassXC', level: 3, catalogId: 'keepassxc' },
      { id: 'vaultwarden', name: 'Vaultwarden', level: 3, catalogId: 'vaultwarden' },
      { id: 'aliasvault', name: 'AliasVault', level: 2 },
      { id: 'gopass', name: 'Gopass', level: 2 },
      { id: 'keevault', name: 'Kee Vault', level: 2 },
      { id: 'proton_pass', name: 'Proton Pass', level: 2 },
      { id: '1password', name: '1Password', level: 1 },
      { id: 'murena_workspace', name: 'Murena Passwords', level: 1 }
    ],
    pick: 'bitwarden',
  },
  {
    id: '2fa', name: '2FA', order: 9,
    mainstream: [{ id: 'google_auth', name: 'Google Auth' }, { id: 'microsoft_auth', name: 'Microsoft Auth' }, { id: 'authy', name: 'Authy' }, { id: 'apple_passwords', name: 'Apple Passwords' }],
    alternatives: [
      { id: 'aegis_auth', name: 'Aegis Auth', level: 3, catalogId: 'aegis' },
      { id: 'ente_auth', name: 'Ente Auth', level: 3, catalogId: 'ente-auth' },
      { id: '2fas_auth', name: '2FAS Auth', level: 2 },
      { id: 'bitwarden_auth', name: 'Bitwarden Auth', level: 2 },
      { id: 'freeotp', name: 'FreeOTP', level: 2 },
      { id: 'proton_auth', name: 'Proton Auth', level: 2 },
      { id: 'vaultwarden', name: 'Vaultwarden', level: 2, catalogId: 'vaultwarden' },
      { id: 'yubico_auth', name: 'Yubico Authenticator', level: 2 },
      { id: '1password', name: '1Password', level: 1 },
      { id: 'stratum', name: 'Stratum', level: 1 }
    ],
    pick: 'ente_auth',
  },
  {
    id: 'calendar', name: 'Calendar', order: 10,
    mainstream: [{ id: 'google_calendar', name: 'Google Calendar' }, { id: 'outlook_calendar', name: 'Outlook Calendar' }, { id: 'apple_calendar', name: 'Apple Calendar' }],
    alternatives: [
      { id: 'fossify_calendar', name: 'Fossify Calendar', level: 3, catalogId: 'fossify-calendar' },
      { id: 'proton_calendar', name: 'Proton Calendar', level: 3 },
      { id: 'tuta_calendar', name: 'Tuta Calendar', level: 3 },
      { id: 'radicale', name: 'Radicale', level: 2 },
      { id: 'mailbox', name: 'mailbox.org', level: 2 },
      { id: 'apple_calendar', name: 'Apple Calendar', level: 1 },
      { id: 'murena_workspace', name: 'Murena Calendar', level: 1 },
      { id: 'nextcloud_calendar', name: 'Nextcloud Calendar', level: 1 }
    ],
    pick: 'fossify_calendar',
  },
  {
    id: 'contacts', name: 'Contacts', order: 11,
    mainstream: [{ id: 'google_contacts', name: 'Google Contacts' }],
    alternatives: [
      { id: 'fossify_contacts', name: 'Fossify Contacts', level: 3, catalogId: 'fossify-contacts' },
      { id: 'proton_mail', name: 'Proton Contacts', level: 2, catalogId: 'proton-mail' },
      { id: 'tuta_mail', name: 'Tuta Contacts', level: 2, catalogId: 'tuta' }
    ],
    pick: 'fossify_contacts',
  },
  {
    id: 'app-store', name: 'App Store', order: 12,
    mainstream: [{ id: 'play_store', name: 'Play Store' }, { id: 'app_store', name: 'App Store' }],
    alternatives: [
      { id: 'f_droid', name: 'F-Droid', level: 3, catalogId: 'f-droid' },
      { id: 'accrescent', name: 'Accrescent', level: 2 },
      { id: 'aurora_store', name: 'Aurora Store', level: 2 },
      { id: 'obtainium', name: 'Obtainium', level: 2 },
      { id: 'app_store', name: 'App Store', level: 1 }
    ],
    pick: 'f_droid',
  },
  {
    id: 'vpn', name: 'VPN', order: 13,
    mainstream: [{ id: 'no_vpn', name: 'No VPN' }, { id: 'nordvpn', name: 'NordVPN' }, { id: 'expressvpn', name: 'ExpressVPN' }, { id: 'surfshark', name: 'Surfshark' }],
    alternatives: [
      { id: 'mullvad_vpn', name: 'Mullvad VPN', level: 3, catalogId: 'mullvad-vpn' },
      { id: 'tor_vpn', name: 'Tor VPN', level: 3 },
      { id: 'ivpn', name: 'IVPN', level: 2 },
      { id: 'mozilla_vpn', name: 'Mozilla VPN', level: 2 },
      { id: 'nymvpn', name: 'NymVPN', level: 2 },
      { id: 'obscura_vpn', name: 'Obscura VPN', level: 2 },
      { id: 'portmaster_spn', name: 'Portmaster SPN', level: 2 },
      { id: 'proton_vpn', name: 'Proton VPN', level: 2, catalogId: 'proton-vpn' },
      { id: 'brave_vpn', name: 'Brave VPN', level: 1 },
      { id: 'duckduckgo', name: 'DuckDuckGo VPN', level: 1 },
      { id: 'pia_vpn', name: 'PIA VPN', level: 1 },
      { id: 'urnetwork', name: 'URnetwork dVPN', level: 1 },
      { id: 'windscribe', name: 'Windscribe VPN', level: 1 }
    ],
    pick: 'mullvad_vpn',
  },
  {
    id: 'ai-assistant', name: 'AI Assistant', order: 14,
    mainstream: [{ id: 'chatgpt', name: 'ChatGPT' }, { id: 'grok', name: 'Grok' }, { id: 'claude', name: 'Claude' }, { id: 'google_gemini', name: 'Google Gemini' }, { id: 'microsoft_copilot', name: 'Microsoft Copilot' }, { id: 'deepseek', name: 'DeepSeek' }, { id: 'meta_ai', name: 'Meta AI' }, { id: 'perplexity', name: 'Perplexity' }],
    alternatives: [
      { id: 'ollama', name: 'Ollama', level: 3, catalogId: 'ollama' },
      { id: 'apple_intelligence', name: 'Apple Intelligence', level: 2 },
      { id: 'duckai', name: 'Duck.ai', level: 2 },
      { id: 'mistralai_lechat', name: 'LeChat', level: 2 },
      { id: 'lumo', name: 'Lumo', level: 2 },
      { id: 'brave_leo', name: 'Brave Leo', level: 1 },
      { id: 'ensu', name: 'Ensu', level: 1 },
      { id: 'ik-euria', name: 'Euria', level: 1 },
      { id: 'kagi_assistant', name: 'Kagi Assistant', level: 1 },
      { id: 'maple_ai', name: 'Maple AI', level: 1 },
      { id: 'ppq', name: 'PayPerQ', level: 1 },
      { id: 'routstr', name: 'Routstr', level: 1 }
    ],
    pick: 'ollama',
  },
  {
    id: 'smart-home', name: 'Smart Home', order: 15,
    mainstream: [{ id: 'google_home', name: 'Google Home' }, { id: 'apple_homekit', name: 'Apple HomeKit' }, { id: 'amazon_alexa', name: 'Amazon Alexa' }, { id: 'samsung_smartthings', name: 'Samsung SmartThings' }, { id: 'philips_hue', name: 'Philips Hue' }],
    alternatives: [
      { id: 'home_assistant', name: 'Home Assistant', level: 3, catalogId: 'home-assistant' },
      { id: 'openhab', name: 'OpenHAB', level: 3 },
      { id: 'apple_homekit', name: 'Apple HomeKit', level: 2 },
      { id: 'domoticz', name: 'Domoticz', level: 2 },
      { id: 'iobroker', name: 'ioBroker', level: 2 }
    ],
    pick: 'home_assistant',
  },
  {
    id: 'maps', name: 'Maps', order: 16,
    mainstream: [{ id: 'google_maps', name: 'Google Maps' }, { id: 'apple_maps', name: 'Apple Maps' }],
    alternatives: [
      { id: 'comaps', name: 'CoMaps', level: 3 },
      { id: 'organic_maps', name: 'Organic Maps', level: 3, catalogId: 'organicmaps' },
      { id: 'osmand', name: 'OsmAnd', level: 3 },
      { id: 'magic_earth', name: 'Magic Earth', level: 2 },
      { id: 'apple_maps', name: 'Apple Maps', level: 1 },
      { id: 'kagi', name: 'Kagi Maps', level: 1 }
    ],
    pick: 'organic_maps',
  },
  {
    id: 'translator', name: 'Translator', order: 17,
    mainstream: [{ id: 'google_translate', name: 'Google Translate' }, { id: 'apple_translate', name: 'Apple Translate' }, { id: 'deepl', name: 'DeepL' }],
    alternatives: [
      { id: 'libretranslate', name: 'LibreTranslate', level: 3, catalogId: 'libretranslate' },
      { id: 'mozilla_translate', name: 'Mozilla Translate', level: 3 },
      { id: 'translatelocally', name: 'TranslateLocally', level: 3 },
      { id: 'apertium', name: 'Apertium', level: 2 },
      { id: 'brave_translate', name: 'Brave Translate', level: 1 },
      { id: 'kagi_translate', name: 'Kagi Translate', level: 1 }
    ],
    pick: 'libretranslate',
  },
  {
    id: 'community', name: 'Community', order: 18,
    mainstream: [{ id: 'discord', name: 'Discord' }, { id: 'guilded', name: 'Guilded' }, { id: 'slack', name: 'Slack' }],
    alternatives: [
      { id: 'discourse', name: 'Discourse', level: 2 },
      { id: 'matrix', name: 'Matrix', level: 2, catalogId: 'element' },
      { id: 'zulip', name: 'Zulip', level: 2 },
      { id: 'fluxer', name: 'Fluxer', level: 1 },
      { id: 'gamevox', name: 'GameVox', level: 1 },
      { id: 'stoat', name: 'Stoat', level: 1 }
    ],
    pick: 'matrix',
  },
  {
    id: 'social-media', name: 'Social Media', order: 19,
    mainstream: [{ id: 'facebook', name: 'Facebook' }, { id: 'instagram', name: 'Instagram' }, { id: 'threads', name: 'Threads' }, { id: 'x', name: '𝕏' }, { id: 'reddit', name: 'Reddit' }, { id: 'youtube', name: 'YouTube' }],
    alternatives: [
      { id: 'lemmy', name: 'Lemmy', level: 2 },
      { id: 'mastodon', name: 'Mastodon', level: 2, catalogId: 'mastodon' },
      { id: 'nostr', name: 'Nostr', level: 2 },
      { id: 'peertube', name: 'PeerTube', level: 2 },
      { id: 'pixelfed', name: 'Pixelfed', level: 2 },
      { id: 'minds', name: 'Minds', level: 1 }
    ],
    pick: 'mastodon',
  },
  {
    id: 'video-conferencing', name: 'Video Conferencing', order: 20,
    mainstream: [{ id: 'zoom', name: 'Zoom' }, { id: 'google_meet', name: 'Google Meet' }, { id: 'microsoft_teams', name: 'Microsoft Teams' }, { id: 'webex', name: 'Webex' }],
    alternatives: [
      { id: 'proton_meet', name: 'Proton Meet', level: 3 },
      { id: 'brave_talk', name: 'Brave Talk', level: 2 },
      { id: 'jitsi', name: 'Jitsi', level: 2, catalogId: 'jitsi-meet' },
      { id: 'nextcloud_talk', name: 'Nextcloud Talk', level: 2 }
    ],
    pick: 'jitsi',
  },
  {
    id: 'payments', name: 'Payments', order: 21,
    mainstream: [{ id: 'paypal', name: 'PayPal' }, { id: 'venmo', name: 'Venmo' }, { id: 'zelle', name: 'Zelle' }, { id: 'cash_app', name: 'Cash App' }, { id: 'apple_pay', name: 'Apple Pay' }, { id: 'google_pay', name: 'Google Pay' }],
    alternatives: [
      { id: 'monero', name: 'Monero', level: 3 },
      { id: 'zcash', name: 'Zcash', level: 2 },
      { id: 'apple_pay', name: 'Apple Pay', level: 1 },
      { id: 'cash', name: 'Cash', level: 1 }
    ],
    pick: 'monero',
  },
  {
    id: 'crypto-wallets', name: 'Crypto Wallets', order: 22,
    mainstream: [{ id: 'coinbase_wallet', name: 'Coinbase Wallet' }, { id: 'metamask', name: 'MetaMask' }, { id: 'phantom', name: 'Phantom' }, { id: 'trust_wallet', name: 'Trust Wallet' }],
    alternatives: [
      { id: 'cake_wallet', name: 'Cake Wallet', level: 3, catalogId: 'cake-wallet' },
      { id: 'brave_wallet', name: 'Brave Wallet', level: 2 },
      { id: 'proton_wallet', name: 'Proton Wallet', level: 2 },
      { id: 'zodl', name: 'ZODL', level: 1 }
    ],
    pick: 'cake_wallet',
  },
  {
    id: 'dns', name: 'DNS', order: 23,
    mainstream: [{ id: 'isp_dns', name: 'ISP DNS' }, { id: 'google_search', name: 'Google DNS' }, { id: 'cloudflare', name: 'Cloudflare DNS' }],
    alternatives: [
      { id: 'adguard', name: 'AdGuard DNS', level: 2 },
      { id: 'controld', name: 'ControlD DNS', level: 2 },
      { id: 'mullvad_dns', name: 'Mullvad DNS', level: 2 },
      { id: 'nextdns', name: 'NextDNS', level: 2 },
      { id: 'opennic', name: 'OpenNIC', level: 2 },
      { id: 'quad9', name: 'Quad9 DNS', level: 2 },
      { id: 'cloudflare', name: 'Cloudflare DNS', level: 1 }
    ],
    pick: 'quad9',
  },
  {
    id: 'computer-os', name: 'Computer OS', order: 24,
    mainstream: [{ id: 'windows', name: 'Windows' }, { id: 'macos', name: 'macOS' }],
    alternatives: [
      { id: 'qubes_os', name: 'Qubes OS', level: 3 },
      { id: 'secureblue', name: 'secureblue', level: 3 },
      { id: 'arch_linux', name: 'Arch Linux', level: 2 },
      { id: 'debian', name: 'Debian', level: 2 },
      { id: 'fedora', name: 'Fedora', level: 2 },
      { id: 'linux_mint', name: 'Linux Mint', level: 2 },
      { id: 'nixos', name: 'NixOS', level: 2 },
      { id: 'pop_os', name: 'Pop!_OS', level: 2 },
      { id: 'zorin_os', name: 'Zorin OS', level: 2 },
      { id: 'opensuse', name: 'openSUSE', level: 2 },
      { id: 'openmandriva', name: 'OpenMandriva', level: 1 },
      { id: 'tiger_os', name: 'Tiger OS', level: 1 },
      { id: 'ubuntu', name: 'Ubuntu', level: 1 },
      { id: 'macos', name: 'macOS', level: 1 }
    ],
    pick: 'linux_mint',
  },
  {
    id: 'phone-os', name: 'Phone OS', order: 25,
    mainstream: [{ id: 'android', name: 'Android' }, { id: 'ios', name: 'iOS' }],
    alternatives: [
      { id: 'graphene_os', name: 'GrapheneOS', level: 3 },
      { id: 'e_os', name: '/e/OS', level: 2 },
      { id: 'calyx_os', name: 'CalyxOS', level: 2 },
      { id: 'lineage_os', name: 'LineageOS', level: 2 },
      { id: 'ios', name: 'iOS', level: 1 }
    ],
    pick: 'graphene_os',
  },
  {
    id: 'entertainment', name: 'Entertainment', order: 26,
    mainstream: [{ id: 'plex', name: 'Plex' }, { id: 'netflix', name: 'Netflix' }, { id: 'hulu', name: 'Hulu' }, { id: 'hbo_max', name: 'HBO Max' }, { id: 'prime_video', name: 'Prime Video' }, { id: 'paramount_plus', name: 'Paramount+' }, { id: 'disney_plus', name: 'Disney+' }, { id: 'youtube', name: 'YouTube' }],
    alternatives: [
      { id: 'jellyfin', name: 'Jellyfin', level: 3, catalogId: 'jellyfin' },
      { id: 'grayjay', name: 'Grayjay', level: 2 },
      { id: 'libretube', name: 'LibreTube', level: 2 },
      { id: 'newpipe', name: 'NewPipe', level: 2, catalogId: 'newpipe' },
      { id: 'stremio', name: 'Stremio', level: 1 }
    ],
    pick: 'jellyfin',
  },
  {
    id: 'office-suite', name: 'Office Suite', order: 27,
    mainstream: [{ id: 'Microsoft_365', name: 'Microsoft 365' }, { id: 'Google_Workspace', name: 'Google Workspace' }, { id: 'Apple_iWork', name: 'Apple iWork' }, { id: 'Zoho_Office', name: 'Zoho Office' }, { id: 'WPS', name: 'WPS Office' }, { id: 'MobiOffice', name: 'MobiOffice' }, { id: 'Polaris_Office', name: 'Polaris Office' }],
    alternatives: [
      { id: 'CryptPad', name: 'CryptPad', level: 3 },
      { id: 'LibreOffice', name: 'LibreOffice', level: 3, catalogId: 'libreoffice' },
      { id: 'proton_docs', name: 'Proton Docs', level: 3 },
      { id: 'Collabora', name: 'Collabora', level: 2 },
      { id: 'fileverse', name: 'Fileverse dDocs/dSheets', level: 2 },
      { id: 'OnlyOffice', name: 'OnlyOffice', level: 2 },
      { id: 'OpenOffice', name: 'OpenOffice', level: 2 }
    ],
    pick: 'LibreOffice',
  },
  {
    id: 'domain-hosting', name: 'Domain Hosting', order: 28,
    mainstream: [{ id: 'godaddy', name: 'GoDaddy' }],
    alternatives: [
      { id: '1984_hosting', name: '1984 Hosting', level: 2 },
      { id: 'njalla', name: 'Njalla', level: 2 },
      { id: 'orangewebsite', name: 'OrangeWebsite', level: 2 },
      { id: 'cloudflare', name: 'Cloudflare Registrar', level: 1 }
    ],
    pick: 'njalla',
  },
];
