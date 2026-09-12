# Contributing to Fress

Thank you for helping keep Fress clean and trustworthy.

## Ground rules

1. **Every app must be genuinely free and open source.** Freeware with a closed license does not qualify. The license badge must match reality.
2. **Popular and tested.** At least one of: 1,000+ GitHub stars, a major distro package, or years of established community use.
3. **Official links only.** Website, repository, and download URLs must point to the project's own domain or its official GitHub/GitLab. No mirrors, no affiliate links.
4. **Honest descriptions.** No marketing fluff. Say what the app does and what it replaces.
5. **Check links before submitting.** A broken or moved link is the most common defect.

## Adding an app

1. Edit `src/data/appsDataExtra.ts` (or `appsData.ts` for the original set).
2. Follow the existing `AppItem` shape in `src/types.ts`.
3. Include: id (lowercase, unique), tagline (one line), description (2-3 sentences), beginner guide, platform list, license, official URLs, and package-manager commands when they exist.
4. Set `addedAt`-style honesty: only submit links you personally opened today.
5. One pull request per app keeps review fast.

## The Pick

There is exactly **one** Owner Pick in the catalog (currently VLC). Please do not add more; it is meant to be a single, hard-earned recommendation.

## Code changes

- `npm run lint` must pass.
- Keep components dependency-light; new npm packages need a justification.
- Test in **both light and dark themes** before submitting UI changes.
- If you add UI text, add the string to `src/lib/i18n.tsx` for all five languages (English plus at least one other is acceptable; translators will follow).

## Reporting a broken link

Open an issue titled `link rot: <app name>` with the app id and what changed (dead URL, new official domain, abandoned project). Issues are triaged by last-checked date.
