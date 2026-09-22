export type Platform = 'windows' | 'mac' | 'linux' | 'web' | 'android' | 'ios';

export type Category = 
  | 'All'
  | 'Productivity & Office'
  | 'Developer & Code'
  | 'Design & Creative'
  | 'Utilities & System'
  | 'Privacy & Security'
  | 'Media, Audio & Video';

export type BeginnerRating = 
  | 'Super Beginner Friendly'
  | 'Quick Learning Curve'
  | 'Advanced / Power User';

export interface AppItem {
  id: string;
  name: string;
  tagline: string;
  description: string;
  whyItsAwesome: string;
  beginnerGuide: string;
  githubUrl: string;
  /** Second official source link when a project also publishes on GitLab. */
  gitlabUrl?: string;
  websiteUrl: string;
  downloadUrl?: string;
  category: Category;
  platforms: Platform[];
  license: string;
  stars: number;
  beginnerRating?: BeginnerRating;
  isOwnerPick: boolean;
  isTrendingToday: boolean;
  tags: string[];
  wingetCommand?: string;
  brewCommand?: string;
  flatpakCommand?: string;
  scoopCommand?: string;
  aptCommand?: string;
  fdroidId?: string;
  playStoreId?: string;
  proprietaryAlternative?: string;
  isPortable?: boolean;
  architectures?: ('x86_64' | 'arm64' | 'universal')[];
  offlineReady?: boolean;
  /** Date (YYYY-MM-DD) a human last re-checked this entry's links, releases
   * and metadata. Optional until the entry is next reviewed; the detail
   * modal shows it when present so freshness is never pretended. */
  lastVerifiedAt?: string;
  /** Per-platform asset-name regexes (case-insensitive) for projects whose
   * release files follow no common naming scheme. When one matches, it
   * outranks the heuristic asset picker entirely. Example:
   *   assetPatterns: { windows: 'myapp-.*?-win64(-portable)?\\.zip' } */
  assetPatterns?: Partial<Record<Platform, string>>;
  addedAt: string;
  isCustom?: boolean;
}

export interface FilterState {
  search: string;
  category: Category;
  platform: Platform | 'all';
  beginnerOnly: boolean;
  ownerPickOnly: boolean;
  trendingOnly: boolean;
  favoritesOnly: boolean;
  customOnly: boolean;
  sortBy: 'stars' | 'name' | 'newest';
}
