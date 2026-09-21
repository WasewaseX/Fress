import type { LucideIcon } from 'lucide-react';
import {
  MessagesSquare,
  Compass,
  Mail,
  KeyRound,
  HardDrive,
  Smartphone,
  PackageOpen,
  Clapperboard,
  Palette,
  NotebookPen,
  House,
  Briefcase,
  ShieldCheck,
  Images,
} from 'lucide-react';

/**
 * App combos: small kits that solve one problem together, the same idea as
 * ente's PrivacyPack (github.com/ente/privacypack) but built only from the
 * apps already vetted in this catalog. Every id must exist in appsData, so a
 * combo can never point at something that is not in the app.
 */
export interface Combo {
  id: string;
  name: string;
  purpose: string;
  note: string;
  icon: LucideIcon;
  /** Tailwind classes for the small icon tile. */
  tile: string;
  /** Catalog app ids, roughly in the order you would install them. */
  appIds: string[];
}

export const COMBOS: Combo[] = [
  {
    id: 'private-messaging',
    name: 'Private messaging',
    purpose: 'Talk, call and share files without a server keeping copies.',
    note: 'Signal covers chats and calls with end-to-end encryption that has been audited for years. LocalSend moves files device to device over your own Wi-Fi, and Jitsi Meet gives video meetings in the browser with no account at all. Nothing here asks for a phone book upload or an ad profile.',
    icon: MessagesSquare,
    tile: 'bg-emerald-500/15 text-emerald-400',
    appIds: ['signal', 'localsend', 'jitsi-meet'],
  },
  {
    id: 'anonymous-browsing',
    name: 'Anonymous browsing',
    purpose: 'Read the web without being read along with it.',
    note: 'Tor Browser routes traffic through three relays so no single site knows who or where you are. SearXNG is a metasearch page you can self-host that forwards queries without cookies or a search history. Pi-hole blocks ad and tracker domains for every device on your network, including TVs and gadgets that ignore browser extensions.',
    icon: Compass,
    tile: 'bg-sky-500/15 text-sky-400',
    appIds: ['tor-browser', 'searxng', 'pi-hole'],
  },
  {
    id: 'private-email',
    name: 'Private email',
    purpose: 'A mailbox the provider itself cannot read.',
    note: 'Tuta encrypts everything by default, including subject lines, and publishes a warrant canary. Proton Mail sits under Swiss law with zero-access encryption and passed independent audits. Thunderbird ties it together on the desktop as a normal mail client for any leftover accounts.',
    icon: Mail,
    tile: 'bg-rose-500/15 text-rose-400',
    appIds: ['tuta', 'proton-mail', 'thunderbird'],
  },
  {
    id: 'passwords-keys',
    name: 'Passwords and keys',
    purpose: 'One vault per situation, all end-to-end encrypted.',
    note: 'Bitwarden syncs passwords across devices with zero-knowledge encryption and can self-host via Vaultwarden. KeePassXC keeps a local file vault with no account behind it at all, and KeePassDX opens the same file on Android. Between them you get cloud sync and offline-only storage in one kit.',
    icon: KeyRound,
    tile: 'bg-amber-500/15 text-amber-400',
    appIds: ['bitwarden', 'keepassxc', 'keepassdx'],
  },
  {
    id: 'second-factor',
    name: 'Second factor kit',
    purpose: 'Move 2FA off SMS and into apps that cannot leak it.',
    note: 'Ente Auth generates codes offline and syncs them encrypted, so a lost phone never locks you out. Aegis keeps tokens in a vault on an Android phone that has no internet permission at all. Bitwarden rounds it out as the zero-knowledge password manager those codes protect. Two factors, two separate apps, one breach takes neither.',
    icon: ShieldCheck,
    tile: 'bg-green-500/15 text-green-400',
    appIds: ['ente-auth', 'aegis', 'bitwarden'],
  },
  {
    id: 'own-your-files',
    name: 'Own your files',
    purpose: 'Sync and back up photos without a cloud copy of your life.',
    note: 'Syncthing replicates folders between devices directly, peer to peer, with nothing in the middle. Nextcloud is the full self-hosted drive with sharing and calendars, and Immich rebuilds the Google Photos experience on your own hardware, phone backup and face search included.',
    icon: HardDrive,
    tile: 'bg-violet-500/15 text-violet-400',
    appIds: ['syncthing', 'nextcloud', 'immich'],
  },
  {
    id: 'photo-backup',
    name: 'Photo backup',
    purpose: 'Get photos off your phone without handing them to a scanner.',
    note: 'Ente Photos encrypts every shot before upload, so the cloud keeps your library but never sees it. Immich runs the same kind of backup on your own hardware if you would rather have no cloud in the loop. Fossify Gallery keeps the phone itself clean, an ad-free viewer with none of the tracking that crept into the apps it forked from.',
    icon: Images,
    tile: 'bg-blue-500/15 text-blue-400',
    appIds: ['ente-photos', 'immich', 'fossify-gallery'],
  },
  {
    id: 'android-kit',
    name: 'Private Android kit',
    purpose: 'A de-Googled phone that still does everything.',
    note: 'F-Droid is the open-source app store and the safest place to install from outside Play. NewPipe plays YouTube without an account or ads, Organic Maps works fully offline, AntennaPod handles podcasts, Termux opens a real Linux terminal, and KeePassDX keeps your vault in your pocket.',
    icon: Smartphone,
    tile: 'bg-lime-500/15 text-lime-400',
    appIds: ['f-droid', 'newpipe', 'organicmaps', 'antennapod', 'keepassdx', 'termux'],
  },
  {
    id: 'fresh-setup',
    name: 'Fresh system setup',
    purpose: 'The first five tools to install on a new computer.',
    note: '7-Zip unpacks everything, balenaEtcher flashes bootable USB sticks, BleachBit clears out what you do not need, Sumatra PDF opens documents instantly without a bloated reader, and PowerToys adds the small Windows conveniences Microsoft left out. All five are light, free and portable.',
    icon: PackageOpen,
    tile: 'bg-orange-500/15 text-orange-400',
    appIds: ['7zip', 'balenaetcher', 'bleachbit', 'sumatra', 'powertoys'],
  },
  {
    id: 'video-studio',
    name: 'Video studio',
    purpose: 'Record, edit, mix and export video for zero dollars.',
    note: 'OBS Studio records and streams scenes the pros use on Twitch. Kdenlive is a real multi-track editor, Audacity cleans up the audio, and HandBrake compresses the final export to a size you can actually send. A full post-production bench with no watermarks and no subscriptions.',
    icon: Clapperboard,
    tile: 'bg-fuchsia-500/15 text-fuchsia-400',
    appIds: ['obs-studio', 'kdenlive', 'audacity', 'handbrake'],
  },
  {
    id: 'image-workshop',
    name: 'Image workshop',
    purpose: 'Draw, edit and upscale images without a Creative Cloud bill.',
    note: 'GIMP edits photos, Krita paints from scratch with brushes that feel like real ones, Inkscape draws vector logos that scale to any size, and Upscayl enlarges old or small pictures locally on your GPU. Four tools that cover raster, vector and everything between.',
    icon: Palette,
    tile: 'bg-pink-500/15 text-pink-400',
    appIds: ['gimp', 'krita', 'inkscape', 'upscayl'],
  },
  {
    id: 'write-research',
    name: 'Write and research',
    purpose: 'Draft, take notes and manage sources like a scholar.',
    note: 'LibreOffice handles documents and spreadsheets in every format your school or office uses. Joplin keeps synced notebooks with Markdown and end-to-end encryption, Zotero collects papers and spits out citations in 10,000 styles, and Calibre runs the e-book library.',
    icon: NotebookPen,
    tile: 'bg-cyan-500/15 text-cyan-400',
    appIds: ['libreoffice', 'joplin', 'zotero', 'calibre'],
  },
  {
    id: 'self-hosted-home',
    name: 'Self-hosted home',
    purpose: 'A smart home that answers to you, not a cloud.',
    note: 'Home Assistant glues every light, sensor and camera into one local dashboard that works even when the internet is down. Pi-hole strips ads for the whole network, Nextcloud holds the files, and Immich the photos. One always-on box runs all four.',
    icon: House,
    tile: 'bg-teal-500/15 text-teal-400',
    appIds: ['home-assistant', 'pi-hole', 'nextcloud', 'immich'],
  },
  {
    id: 'self-hosted-office',
    name: 'Self-hosted office',
    purpose: 'Run the tools a small business pays monthly for, on your own box.',
    note: 'NocoDB is the database-and-forms layer, Listmonk sends newsletters to millions without per-subscriber fees, Formbricks collects surveys, Cal.com takes bookings, and Vaultwarden serves team passwords. Five servers, one Docker machine, no SaaS invoices.',
    icon: Briefcase,
    tile: 'bg-indigo-500/15 text-indigo-400',
    appIds: ['nocodb', 'listmonk', 'formbricks', 'cal-com', 'vaultwarden'],
  },
];
