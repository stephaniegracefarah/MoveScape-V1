/**
 * Computes the correct sessionIndex for a new session (spec Part 3, "The
 * seed system": "The session seed is hash(worldSeed, sessionIndex) ... the
 * first session of the day is index 0, the second index 1").
 *
 * Nothing in the codebase computes this today -- src/main.ts currently
 * hardcodes sessionIndex to 0 on every session, which collides in
 * recipe-store.ts's `${worldSeed}:${sessionIndex}` key: two sessions on the
 * same day would both claim index 0 and silently overwrite each other. This
 * module fixes the computation; wiring it into main.ts is separate work.
 */
import type { RecipeStore } from './recipe-store';

/**
 * The correct sessionIndex for a new session against `worldSeed`: one past
 * the highest sessionIndex already saved for that worldSeed today, or 0 if
 * none exist yet. Reads the full store rather than a worldSeed-scoped query
 * because RecipeStore has no such query today (its IndexedDB store is keyed
 * by id only) -- fine at v1's expected local scale (see recipe-store.ts's
 * own docs).
 */
export async function nextSessionIndexFor(store: RecipeStore, worldSeed: string): Promise<number> {
  const all = await store.list();

  let maxIndex = -1;
  for (const stored of all) {
    if (stored.recipe.worldSeed !== worldSeed) continue;
    if (stored.recipe.sessionIndex > maxIndex) {
      maxIndex = stored.recipe.sessionIndex;
    }
  }

  return maxIndex + 1;
}
