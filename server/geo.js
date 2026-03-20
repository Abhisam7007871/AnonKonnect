const worldCountries = require("world-countries");

const countryToRegion = new Map(
  worldCountries.flatMap((country) => {
    const region = country.subregion || country.region || "Global";
    return [
      [country.name.common, region],
      [country.name.official, region],
      [country.cca2, region],
      [country.cca3, region],
    ];
  }),
);

countryToRegion.set("United States", countryToRegion.get("US") || "Northern America");
countryToRegion.set("United Kingdom", "Northern Europe");
countryToRegion.set("UK", "Northern Europe");

function getRegion(country) {
  return countryToRegion.get(country) || "Global";
}

function getGeoTier(userA, userB) {
  if (userA?.state && userA.state === userB?.state) {
    return "state";
  }

  if (userA?.country && userA.country === userB?.country) {
    return "country";
  }

  if (getRegion(userA?.country) === getRegion(userB?.country)) {
    return "region";
  }

  return "global";
}

function getStage(waitMs) {
  if (waitMs < 60_000) {
    return "state";
  }

  if (waitMs < 120_000) {
    return "country";
  }

  if (waitMs < 180_000) {
    return "region";
  }

  return "global";
}

function allowsTier(stage, tier) {
  const rank = { state: 0, country: 1, region: 2, global: 3 };
  return rank[tier] <= rank[stage];
}

function getStatusLabel(stage, country) {
  if (stage === "state") {
    return `Finding nearby matches (same state first)`;
  }

  if (stage === "country") {
    return `Expanding to country-wide matches`;
  }

  if (stage === "region") {
    return `Expanding to nearby regions`;
  }

  return `Searching globally for the fastest match`;
}

module.exports = {
  getGeoTier,
  getRegion,
  getStage,
  allowsTier,
  getStatusLabel,
};
