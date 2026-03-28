export class VersionConflictError extends Error {
  constructor(
    public readonly entityType: string,
    public readonly entityId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion?: number,
  ) {
    const actual = actualVersion !== undefined ? `, actual ${actualVersion}` : '';
    super(`Version conflict on ${entityType}/${entityId}: expected ${expectedVersion}${actual}`);
    this.name = 'VersionConflictError';
  }
}
