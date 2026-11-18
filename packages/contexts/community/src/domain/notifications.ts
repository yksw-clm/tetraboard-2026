export const notificationPageSize = 20;

export function canMarkAllNotificationsRead(through: number, issuedThrough: number): boolean {
  return through <= issuedThrough;
}
