// Every worker data function takes the workspace id right after `db` and starts with wsId(). A missing or malformed
// id then fails loudly, instead of quietly matching nothing (or, in a careless query, everything).
export function wsId(value) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError('workspaceId must be a positive integer');
  return value;
}
