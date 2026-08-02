/** GoalFollow range — keep tight so GoalNear does not count walls as arrived. */
export const FOLLOW_GOAL_RANGE = 1;
/** Above this Y gap the owner is treated as on another floor. */
export const SAME_FLOOR_DY = 2;
/** Fallback when config omits follow_distance. */
export const DEFAULT_FOLLOW_DISTANCE = 3;
/** Fallback when config omits follow_min_distance. */
export const DEFAULT_FOLLOW_MIN_DISTANCE = 2;
/** Stop once within this distance of the last-known owner position. */
export const LAST_KNOWN_ARRIVE_RANGE = 3;
