import { DEFAULT_PROFILE, validateProfileName } from './profile-name.js';

const MAX_SUGGESTIONS = 3;
const MAX_NAMES_TO_COMPARE = 500;

function profileNameFromEntry(entry: unknown): string | undefined {
  const value =
    typeof entry === 'string'
      ? entry
      : typeof entry === 'object' && entry !== null && 'name' in entry
        ? (entry as { name: unknown }).name
        : undefined;
  if (typeof value !== 'string') return undefined;
  try {
    return validateProfileName(value);
  } catch {
    return undefined;
  }
}

function editDistance(left: string, right: string): number {
  const previousPrevious: number[] = [];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + substitutionCost,
      );
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        current[j] = Math.min(current[j]!, previousPrevious[j - 2]! + 1);
      }
    }
    previousPrevious.splice(0, previousPrevious.length, ...previous);
    previous = current;
  }

  return previous[right.length]!;
}

export function suggestProfileNames(
  requested: string,
  knownProfiles: readonly unknown[],
): string[] {
  const normalizedRequest = requested.toLowerCase();
  const matches: { name: string; distance: number }[] = [];
  const seen = new Set<string>();

  for (const entry of knownProfiles.slice(0, MAX_NAMES_TO_COMPARE)) {
    const name = profileNameFromEntry(entry);
    if (!name) continue;
    const normalizedName = name.toLowerCase();
    if (normalizedName === normalizedRequest || seen.has(normalizedName)) continue;
    seen.add(normalizedName);

    const distance = editDistance(normalizedRequest, normalizedName);
    const maxLength = Math.max(normalizedRequest.length, normalizedName.length);
    const threshold = Math.min(3, Math.max(1, Math.floor(maxLength / 5)));
    if (distance <= threshold) matches.push({ name, distance });
  }

  return matches
    .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name))
    .slice(0, MAX_SUGGESTIONS)
    .map((match) => match.name);
}

export function formatMissingProfileGuidance(
  requested: string,
  knownProfiles: readonly unknown[],
): string {
  const suggestions = suggestProfileNames(requested, knownProfiles);
  const lines: string[] = [];

  if (suggestions.length === 1) {
    lines.push(`Did you mean "${suggestions[0]}"?`);
  } else if (suggestions.length > 1) {
    lines.push(
      `Did you mean one of these profiles: ${suggestions.map((name) => `"${name}"`).join(', ')}?`,
    );
  }

  lines.push('Run `noxctl profile list` to see registered profiles.');
  lines.push('To create "' + requested + '", run `noxctl init --profile ' + requested + '` first.');
  return lines.join('\n');
}

export function shouldShowProfileBanner(
  profileName: string,
  stderrIsTTY: boolean,
  actionName: string,
  parentName?: string,
): boolean {
  if (profileName.toLowerCase() === DEFAULT_PROFILE || !stderrIsTTY) return false;
  if (actionName === 'current' || actionName === 'serve') return false;
  if (actionName === 'use' && parentName === 'profile') return false;
  return true;
}
