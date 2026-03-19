const globalStore = globalThis.__anonKonnectStore || {
  users: [],
  rooms: [
    {
      id: "us-lounge",
      slug: "us-lounge",
      name: "US Night Lounge",
      description: "Late-night conversations, memes, and casual icebreakers.",
      category: "Friendship",
      region: "US",
      isPrivate: false,
      requiresAccess: false,
    },
    {
      id: "uk-spotlight",
      slug: "uk-spotlight",
      name: "UK Spotlight",
      description: "Regional public room for UK-based chatters.",
      category: "Regional",
      region: "UK",
      isPrivate: false,
      requiresAccess: false,
    },
    {
      id: "india-vibes",
      slug: "india-vibes",
      name: "India Vibes",
      description: "Fast-moving public chat around music, cricket, and campus life.",
      category: "Regional",
      region: "India",
      isPrivate: false,
      requiresAccess: false,
    },
    {
      id: "creator-circle",
      slug: "creator-circle",
      name: "Creator Circle",
      description: "Interest-based room for makers, indie builders, and designers.",
      category: "Interests",
      region: "Global",
      isPrivate: false,
      requiresAccess: false,
    },
  ],
};

globalThis.__anonKonnectStore = globalStore;

export const fallbackStore = globalStore;
