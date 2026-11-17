export function createGuestUsername(id: string): string {
  return `guest_${id.replaceAll("-", "").slice(0, 14)}`;
}

export function isGuestUsernameCollision(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint/.test(error.message) &&
    /user\.username|user_username_normalized_idx/.test(error.message)
  );
}
