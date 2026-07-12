// Shared world constants. The ONLY file modules may share besides events.

export const ROOF_Y = 24;          // top surface of player building (8 floors x 3m)
export const STREET_Y = 0;

// Player building footprint (player rig at origin on the roof).
// Parapet edge the player throws over is at z = -BUILDING_HALF_D.
export const BUILDING_HALF_W = 9;  // x extent
export const BUILDING_HALF_D = 7;  // z extent

// Street canyon: the main street runs along X, in front of the player (-Z).
export const STREET_NEAR_Z = -BUILDING_HALF_D;   // our facade
export const STREET_FAR_Z = -27;                 // facing building facade
export const STREET_CENTER_Z = -17;

// Facing office building (breakable windows on its +Z face).
export const FACING_BUILDING = {
  x: 0, halfW: 14, z: -38, halfD: 11, height: 30,
};

// Park lives to the -X side of the street crossing.
export const PARK = { x: -38, z: -17, halfW: 16, halfD: 12 };

export const GRAVITY = -9.8;
export const MAX_BODIES = 24;
export const BODY_LIFETIME = 30;   // seconds
export const KILL_Y = -5;

export const COMBO_WINDOW = 6;     // seconds between hits to keep combo
export const SLOWMO_THRESHOLD = 300;

export const THROW_BOOST = 1.25;
export const GRAB_RADIUS = 0.28;
