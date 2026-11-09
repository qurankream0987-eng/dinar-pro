/** Bounded spring for surface entrances. Never used for transactional lifecycle state. */
export const surfaceSpring = {
  type: "spring",
  stiffness: 240,
  damping: 28,
  mass: 0.8,
} as const;
