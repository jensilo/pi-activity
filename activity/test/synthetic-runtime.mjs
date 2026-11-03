// Offline/explicit fixture injection only. Low-level transport settings must not
// become public Activity configuration or trigger managed runtime installation.
import activityExtension from "../index.ts";
import { createEvidenceProvider } from "../evidence-provider.ts";

let fixtureProvider = { provider: "none" };

export function setFixtureProvider(config) {
  fixtureProvider = config;
  return { enabled: false };
}

export default function syntheticActivityExtension(pi, judge, blockPresentation, evidenceFactory) {
  const config = { ...fixtureProvider };
  return activityExtension(pi, judge, blockPresentation,
    evidenceFactory ?? (() => createEvidenceProvider(config)));
}
