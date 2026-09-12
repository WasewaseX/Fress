export type Platform = 'windows' | 'mac' | 'linux' | 'web' | 'android' | 'ios';

export type Category = 
  | 'All'
  | 'Productivity & Office'
  | 'Developer & Code'
  | 'Design & Creative'
  | 'Utilities & System'
  | 'Privacy & Security'
  | 'Media, Audio & Video'
  | 'AI & Knowledge';

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

export interface CookieConsentState {
  decided: boolean;
  essential: boolean;
  functional: boolean;
  analytics: boolean;
  updatedAt: string;
}

