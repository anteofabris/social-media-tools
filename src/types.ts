import type { Browser, Page } from "puppeteer";

export interface BrowserConnection {
  browser: Browser;
  page: Page;
}

export interface AccountEntry {
  accountName: string;
  following: boolean;
  dateFollowed: string;
  dateUnfollowed: string | null;
}

export interface AutofollowHashtagResult {
  success: boolean;
  action: "autofollow_hashtags";
  hashtags: string[];
  requested: number;
  totalFollowed: number;
  details: { hashtag: string; followed: number; error?: string }[];
  error: string | null;
}

export interface AutofollowLocationResult {
  success: boolean;
  action: "autofollow_locations";
  locations: string[];
  requested: number;
  totalFollowed: number;
  details: { location: string; followed: number; error?: string }[];
  error: string | null;
}

export interface AutolikeHashtagResult {
  success: boolean;
  action: "autolike_hashtags";
  hashtags: string[];
  requested: number;
  totalLiked: number;
  details: { hashtag: string; liked: number; error?: string }[];
  error: string | null;
}

export interface AutolikeLocationResult {
  success: boolean;
  action: "autolike_locations";
  locations: string[];
  requested: number;
  totalLiked: number;
  details: { location: string; liked: number; error?: string }[];
  error: string | null;
}

export interface AutocommentHashtagResult {
  success: boolean;
  action: "autocomment_hashtags";
  hashtags: string[];
  requested: number;
  totalCommented: number;
  details: { hashtag: string; commented: number; comments: string[]; error?: string }[];
  error: string | null;
}

export interface AutocommentLocationResult {
  success: boolean;
  action: "autocomment_locations";
  locations: string[];
  requested: number;
  totalCommented: number;
  details: { location: string; commented: number; comments: string[]; error?: string }[];
  error: string | null;
}

export interface AutointeractHashtagResult {
  success: boolean;
  action: "autointeract_hashtags";
  hashtags: string[];
  requested: number;
  totalInteracted: number;
  details: {
    hashtag: string;
    interacted: number;
    accounts: {
      username: string;
      followed: boolean;
      postsLiked: number;
      postsCommented: number;
      comments: string[];
    }[];
    error?: string;
  }[];
  error: string | null;
}

export interface AutounfollowResult {
  success: boolean;
  action: "autounfollow";
  requested: number;
  totalUnfollowed: number;
  unfollowed: string[];
  skippedFollowsBack: string[];
  skippedInvalid: string[];
  error: string | null;
}

export interface CollectFollowersResult {
  success: boolean;
  action: "collect_followers";
  expectedCount: number | null;
  accountsFound: number;
  error: string | null;
}

export interface CollectFollowingResult {
  success: boolean;
  action: "collect_following";
  expectedCount: number | null;
  accountsFound: number;
  accountsWritten: number;
  newAccounts: number;
  error: string | null;
}

export interface SetFollowedAccountsResult {
  success: boolean;
  action: "set_followed_accounts";
  expectedCount: number | null;
  accountsFound: number;
  accountsWritten: number;
  newAccounts: number;
  accounts: string[];
  error: string | null;
}
