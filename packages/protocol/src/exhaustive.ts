export function assertNever(value: never): never {
  throw new Error(`Unregistered game: ${String(value)}`);
}
