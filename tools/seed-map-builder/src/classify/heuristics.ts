export type Category =
  | "band"
  | "label"
  | "venue"
  | "festival"
  | "visual_aesthetic"
  | "other";

export interface ClassificationResult {
  category: Category;
  confidence: number;
  evidence: {
    matched_keywords: string[];
    signals: string[];
  };
}

interface KeywordSet {
  bio: string[];
  name: string[];
  website: string[];
  businessCategory: string[];
}

const KEYWORD_MAP: Record<Exclude<Category, "other">, KeywordSet> = {
  band: {
    bio: [
      "musician", "singer", "songwriter", "band", "rapper", "artist",
      "producer", "guitarist", "drummer", "bassist", "vocalist", "mc",
      "dj", "beats", "album", "ep ", "new single", "out now",
      "tour dates", "booking", "live shows", "new music", "listen",
      "stream", "available everywhere",
    ],
    name: [
      "band", "music", "the ", "& the", "trio", "quartet", "ensemble",
      "orchestra", "dj ",
    ],
    website: [
      "bandcamp.com", "soundcloud.com", "spotify.com", "open.spotify",
      "music.apple.com", "distrokid.com", "cdbaby.com", "tunecore.com",
      "linktr.ee",
    ],
    businessCategory: [
      "musician", "artist", "music", "band", "dj",
    ],
  },
  label: {
    bio: [
      "record label", "records", "recordings", "imprint", "releasing",
      "roster", "catalog", "distribution", "a&r", "indie label",
      "underground label", "submit your demo", "demos", "releases",
    ],
    name: [
      "records", "recordings", "music group", "label", "sound",
      "audio", "recordings",
    ],
    website: [
      "bandcamp.com", "label", "records",
    ],
    businessCategory: [
      "record label", "music production",
    ],
  },
  venue: {
    bio: [
      "venue", "live music", "concert hall", "club", "bar &", "taproom",
      "tonight", "doors open", "tickets", "box office", "capacity",
      "stage", "shows nightly", "event space", "music venue",
    ],
    name: [
      "club", "lounge", "bar", "tavern", "hall", "theater", "theatre",
      "room", "house", "pub",
    ],
    website: [
      "ticketmaster.com", "eventbrite.com", "dice.fm", "seetickets.com",
      "axs.com",
    ],
    businessCategory: [
      "venue", "bar", "club", "concert", "nightclub", "performance",
    ],
  },
  festival: {
    bio: [
      "festival", "fest ", "annual", "lineup", "tickets on sale",
      "multi-day", "weekend", "camping", "main stage", "headliner",
    ],
    name: [
      "fest", "festival", "music week",
    ],
    website: [
      "festival", "fest", "eventbrite.com", "dice.fm",
    ],
    businessCategory: [
      "festival", "event",
    ],
  },
  visual_aesthetic: {
    bio: [
      "photographer", "photo", "visual", "designer", "graphic",
      "art director", "creative director", "illustration", "illustrator",
      "motion", "animation", "video", "filmmaker", "director", "cinema",
      "poster", "album art", "cover art", "merch design", "artwork",
    ],
    name: [
      "photo", "design", "studio", "creative", "visual", "art",
    ],
    website: [
      "behance.net", "dribbble.com", "500px.com", "flickr.com",
      "vimeo.com",
    ],
    businessCategory: [
      "photographer", "designer", "artist", "creative",
    ],
  },
};

function matchKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw.toLowerCase()));
}

export function classifyHeuristic(account: {
  username?: string;
  name?: string | null;
  bio?: string | null;
  website?: string | null;
  business_category?: string | null;
}): ClassificationResult {
  // If we have essentially no data, return low-confidence other
  if (!account.bio && !account.name && !account.website && !account.business_category) {
    return {
      category: "other",
      confidence: 0.1,
      evidence: { matched_keywords: [], signals: ["no profile data available"] },
    };
  }

  const scores: Array<{
    category: Category;
    confidence: number;
    matched: string[];
    signals: string[];
  }> = [];

  for (const [cat, kwMap] of Object.entries(KEYWORD_MAP) as Array<
    [Exclude<Category, "other">, KeywordSet]
  >) {
    const matched: string[] = [];
    const signals: string[] = [];

    if (account.bio) {
      const hits = matchKeywords(account.bio, kwMap.bio);
      matched.push(...hits.map((k) => `bio:${k}`));
      if (hits.length > 0) signals.push(`${hits.length} bio keyword(s)`);
    }

    if (account.name) {
      const hits = matchKeywords(account.name, kwMap.name);
      matched.push(...hits.map((k) => `name:${k}`));
      if (hits.length > 0) signals.push(`${hits.length} name keyword(s)`);
    }

    if (account.website) {
      const hits = matchKeywords(account.website, kwMap.website);
      matched.push(...hits.map((k) => `website:${k}`));
      if (hits.length > 0) signals.push("website domain match");
    }

    if (account.business_category) {
      const hits = matchKeywords(account.business_category, kwMap.businessCategory);
      matched.push(...hits.map((k) => `biz_cat:${k}`));
      if (hits.length > 0) signals.push("business category match");
    }

    if (matched.length > 0) {
      const baseConfidence = Math.min(matched.length * 0.12, 0.6);
      const diversityBonus = Math.min(signals.length * 0.12, 0.35);
      const confidence = Math.min(baseConfidence + diversityBonus, 0.95);
      scores.push({ category: cat, confidence, matched, signals });
    }
  }

  if (scores.length === 0) {
    return {
      category: "other",
      confidence: 0.4,
      evidence: { matched_keywords: [], signals: ["no keyword matches"] },
    };
  }

  scores.sort((a, b) => b.confidence - a.confidence);
  const best = scores[0];

  // Penalize ambiguous results
  if (scores.length > 1 && scores[1].confidence > best.confidence * 0.8) {
    best.confidence *= 0.7;
    best.signals.push(`ambiguous: also matches ${scores[1].category}`);
  }

  return {
    category: best.category,
    confidence: best.confidence,
    evidence: { matched_keywords: best.matched, signals: best.signals },
  };
}
